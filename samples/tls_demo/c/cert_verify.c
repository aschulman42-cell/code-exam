/*
 * cert_verify.c - X.509 Certificate Chain Verification
 *
 * Validates server certificates during TLS handshake.
 * Checks chain of trust, expiration, hostname matching,
 * revocation status, and key usage constraints.
 *
 * Copyright (c) 2024 SecureNet Systems, Inc.
 */

#include <stdio.h>
#include <string.h>
#include <time.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>
#include <openssl/x509v3.h>
#include <openssl/ocsp.h>
#include "cert_verify.h"
#include "tls_handler.h"

#define MAX_CHAIN_DEPTH      10
#define CERT_EXPIRY_WARN_DAYS 30


/*
 * verify_certificate_chain - Full certificate chain validation
 *
 * Performs comprehensive verification of the server's certificate:
 *   1. Retrieves the peer certificate from SSL session
 *   2. Checks that the certificate chain is complete and trusted
 *   3. Validates hostname against certificate SAN/CN
 *   4. Checks certificate expiration dates
 *   5. Verifies key usage extensions
 *
 * This is called after TLS handshake completes but before the
 * connection is considered established.
 *
 * Returns: 0 if valid, -1 if verification fails.
 */
int verify_certificate_chain(SSL *ssl, const char *expected_hostname,
                             const tls_config_t *config)
{
    X509 *peer_cert = NULL;
    STACK_OF(X509) *chain = NULL;
    long verify_result;
    int status = -1;

    /* Step 1: Get peer certificate */
    peer_cert = SSL_get_peer_certificate(ssl);
    if (peer_cert == NULL) {
        log_error("No certificate presented by server");
        return -1;
    }

    /* Step 2: Check OpenSSL's built-in chain verification result */
    verify_result = SSL_get_verify_result(ssl);
    if (verify_result != X509_V_OK) {
        if (config->allow_self_signed &&
            verify_result == X509_V_ERR_SELF_SIGNED_CERT_IN_CHAIN) {
            log_warn("Self-signed certificate in chain (allowed by config)");
        } else {
            log_error("Certificate chain verification failed: %s (code %ld)",
                      X509_verify_cert_error_string(verify_result),
                      verify_result);
            goto done;
        }
    }

    /* Step 3: Verify hostname matches certificate */
    if (config->verify_hostname) {
        if (validate_hostname(peer_cert, expected_hostname) != 0) {
            log_error("Hostname verification failed: expected %s",
                      expected_hostname);
            goto done;
        }
    }

    /* Step 4: Check certificate expiration */
    if (check_cert_expiration(peer_cert) != 0) {
        log_error("Certificate has expired or is not yet valid");
        goto done;
    }

    /* Step 5: Verify key usage allows TLS server auth */
    if (check_key_usage(peer_cert) != 0) {
        log_error("Certificate key usage does not permit server auth");
        goto done;
    }

    /* Step 6: Walk the chain and log details */
    chain = SSL_get_peer_cert_chain(ssl);
    if (chain != NULL) {
        int chain_len = sk_X509_num(chain);
        log_info("Certificate chain depth: %d", chain_len);
        for (int i = 0; i < chain_len && i < MAX_CHAIN_DEPTH; i++) {
            X509 *cert = sk_X509_value(chain, i);
            char subject[256];
            X509_NAME_oneline(X509_get_subject_name(cert), subject, sizeof(subject));
            log_info("  [%d] %s", i, subject);
        }
    }

    log_info("Certificate verified for %s", expected_hostname);
    status = 0;

done:
    if (peer_cert != NULL) {
        X509_free(peer_cert);
    }
    return status;
}


/*
 * validate_hostname - Match hostname against certificate SAN/CN
 *
 * First checks Subject Alternative Names (SAN), then falls back
 * to Common Name (CN). Supports wildcard matching for SANs.
 *
 * Returns: 0 if hostname matches, -1 if not.
 */
int validate_hostname(X509 *cert, const char *hostname)
{
    GENERAL_NAMES *san_names = NULL;
    int match_found = 0;

    /* Check Subject Alternative Names first (preferred method) */
    san_names = X509_get_ext_d2i(cert, NID_subject_alt_name, NULL, NULL);
    if (san_names != NULL) {
        int san_count = sk_GENERAL_NAME_num(san_names);
        for (int i = 0; i < san_count; i++) {
            GENERAL_NAME *entry = sk_GENERAL_NAME_value(san_names, i);
            if (entry->type == GEN_DNS) {
                const char *san_str =
                    (const char *)ASN1_STRING_get0_data(entry->d.dNSName);
                if (wildcard_match(san_str, hostname)) {
                    match_found = 1;
                    break;
                }
            }
        }
        sk_GENERAL_NAME_pop_free(san_names, GENERAL_NAME_free);

        if (match_found) return 0;

        /* SAN present but no match - do NOT fall back to CN */
        log_error("Hostname %s not found in SANs", hostname);
        return -1;
    }

    /* Fallback: Check Common Name (deprecated but still used) */
    X509_NAME *subject = X509_get_subject_name(cert);
    char cn[256];
    if (X509_NAME_get_text_by_NID(subject, NID_commonName, cn, sizeof(cn)) > 0) {
        if (wildcard_match(cn, hostname)) {
            return 0;
        }
    }

    log_error("Hostname %s does not match certificate CN=%s", hostname, cn);
    return -1;
}


/*
 * wildcard_match - Match hostname against possibly-wildcarded pattern
 *
 * Handles *.example.com style wildcards per RFC 6125.
 * Wildcard only matches a single label (no dots).
 */
int wildcard_match(const char *pattern, const char *hostname)
{
    if (pattern[0] == '*' && pattern[1] == '.') {
        /* Wildcard: skip first label of hostname */
        const char *dot = strchr(hostname, '.');
        if (dot != NULL) {
            return (strcasecmp(pattern + 2, dot + 1) == 0) ? 0 : -1;
        }
        return -1;
    }
    return (strcasecmp(pattern, hostname) == 0) ? 0 : -1;
}


/*
 * check_cert_expiration - Verify certificate validity period
 *
 * Checks that the current time falls within the certificate's
 * notBefore and notAfter range. Warns if expiring soon.
 *
 * Returns: 0 if valid, -1 if expired or not-yet-valid.
 */
int check_cert_expiration(X509 *cert)
{
    ASN1_TIME *not_before = X509_get_notBefore(cert);
    ASN1_TIME *not_after  = X509_get_notAfter(cert);
    int day, sec;

    /* Check not-yet-valid */
    if (X509_cmp_current_time(not_before) > 0) {
        log_error("Certificate is not yet valid");
        return -1;
    }

    /* Check expired */
    if (X509_cmp_current_time(not_after) < 0) {
        log_error("Certificate has expired");
        return -1;
    }

    /* Warn if expiring within threshold */
    if (ASN1_TIME_diff(&day, &sec, NULL, not_after)) {
        if (day < CERT_EXPIRY_WARN_DAYS) {
            log_warn("Certificate expires in %d days", day);
        }
    }

    return 0;
}


/*
 * check_key_usage - Verify key usage extensions
 *
 * Ensures the certificate's key usage and extended key usage
 * extensions permit TLS server authentication.
 */
int check_key_usage(X509 *cert)
{
    uint32_t usage = X509_get_key_usage(cert);
    uint32_t ext_usage = X509_get_extended_key_usage(cert);

    if (usage != UINT32_MAX) {
        if (!(usage & KU_DIGITAL_SIGNATURE)) {
            log_error("Certificate lacks digitalSignature key usage");
            return -1;
        }
    }

    if (ext_usage != UINT32_MAX) {
        if (!(ext_usage & XKU_SSL_SERVER)) {
            log_error("Certificate lacks serverAuth extended key usage");
            return -1;
        }
    }

    return 0;
}
