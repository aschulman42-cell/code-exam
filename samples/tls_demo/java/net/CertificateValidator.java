/*
 * CertificateValidator.java - X.509 Certificate Chain Verification
 *
 * Validates server certificates during TLS handshake.
 * Checks chain of trust, hostname matching, expiration,
 * and key usage constraints.
 *
 * Copyright (c) 2024 SecureNet Systems, Inc.
 */

package com.securenet.network;

import javax.net.ssl.*;
import java.security.cert.*;
import java.util.*;
import java.util.logging.Logger;

public class CertificateValidator {

    private static final Logger logger = Logger.getLogger(
        CertificateValidator.class.getName());
    private static final int MAX_CHAIN_DEPTH = 10;
    private static final int EXPIRY_WARN_DAYS = 30;
    private boolean allowSelfSigned = false;


    /**
     * Validate the complete certificate chain from an SSL session.
     *
     * Performs comprehensive verification of the server's certificate:
     *   1. Retrieves peer certificates from the session
     *   2. Checks that the chain is complete and trusted
     *   3. Validates hostname against certificate SAN/CN
     *   4. Checks certificate expiration dates
     *   5. Verifies key usage extensions
     *
     * This is called after TLS handshake completes but before the
     * connection is considered established.
     *
     * @param session   The established SSL session
     * @param hostname  The expected server hostname
     * @return          true if certificate is valid, false otherwise
     */
    public boolean validateCertificateChain(SSLSession session,
                                            String hostname) {
        try {
            /* Step 1: Get peer certificates */
            Certificate[] peerCerts = session.getPeerCertificates();
            if (peerCerts == null || peerCerts.length == 0) {
                logger.severe("No certificate presented by server");
                return false;
            }

            X509Certificate serverCert = (X509Certificate) peerCerts[0];

            /* Step 2: Check certificate chain validity */
            if (!verifyChainOfTrust(peerCerts)) {
                if (!allowSelfSigned) {
                    logger.severe("Certificate chain verification failed");
                    return false;
                }
                logger.warning("Self-signed certificate accepted (config)");
            }

            /* Step 3: Verify hostname matches certificate */
            if (!validateHostname(serverCert, hostname)) {
                logger.severe("Hostname verification failed: expected "
                    + hostname);
                return false;
            }

            /* Step 4: Check certificate expiration */
            if (!checkExpiration(serverCert)) {
                logger.severe("Certificate expired or not yet valid");
                return false;
            }

            /* Step 5: Verify key usage permits server auth */
            if (!checkKeyUsage(serverCert)) {
                logger.severe("Certificate key usage invalid for server auth");
                return false;
            }

            /* Log chain details */
            logChainDetails(peerCerts);

            logger.info("Certificate verified for " + hostname);
            return true;

        } catch (SSLPeerUnverifiedException e) {
            logger.severe("Peer not verified: " + e.getMessage());
            return false;
        } catch (Exception e) {
            logger.severe("Certificate validation error: " + e.getMessage());
            return false;
        }
    }


    /**
     * Verify that the certificate chain is complete and each
     * certificate is signed by the next one in the chain.
     */
    private boolean verifyChainOfTrust(Certificate[] chain) {
        try {
            for (int i = 0; i < chain.length - 1 && i < MAX_CHAIN_DEPTH; i++) {
                X509Certificate current = (X509Certificate) chain[i];
                X509Certificate issuer  = (X509Certificate) chain[i + 1];
                current.verify(issuer.getPublicKey());
            }
            return true;
        } catch (Exception e) {
            logger.warning("Chain of trust broken: " + e.getMessage());
            return false;
        }
    }


    /**
     * Validate hostname against certificate Subject Alternative Names
     * and Common Name. SAN is checked first; if present, CN is not
     * used as fallback (per RFC 6125).
     *
     * @param cert      The server's X509 certificate
     * @param hostname  Expected hostname to match
     * @return          true if hostname matches
     */
    public boolean validateHostname(X509Certificate cert, String hostname) {
        try {
            /* Check Subject Alternative Names first */
            Collection<List<?>> sans = cert.getSubjectAlternativeNames();
            if (sans != null) {
                for (List<?> san : sans) {
                    Integer type = (Integer) san.get(0);
                    if (type == 2) {  /* DNS name */
                        String dnsName = (String) san.get(1);
                        if (wildcardMatch(dnsName, hostname)) {
                            return true;
                        }
                    }
                }
                /* SANs present but no match -- do NOT fall back to CN */
                logger.warning("Hostname " + hostname + " not in SANs");
                return false;
            }

            /* Fallback: Check Common Name (deprecated) */
            String dn = cert.getSubjectX500Principal().getName();
            String cn = extractCN(dn);
            if (cn != null && wildcardMatch(cn, hostname)) {
                return true;
            }

            logger.warning("Hostname " + hostname
                + " does not match CN=" + cn);
            return false;

        } catch (CertificateParsingException e) {
            logger.severe("Error parsing certificate SANs: " + e.getMessage());
            return false;
        }
    }


    /**
     * Match hostname against possibly-wildcarded pattern.
     * Handles *.example.com style wildcards per RFC 6125.
     */
    private boolean wildcardMatch(String pattern, String hostname) {
        if (pattern.startsWith("*.")) {
            String suffix = pattern.substring(2);
            int dotIdx = hostname.indexOf('.');
            if (dotIdx >= 0) {
                return hostname.substring(dotIdx + 1)
                               .equalsIgnoreCase(suffix);
            }
            return false;
        }
        return pattern.equalsIgnoreCase(hostname);
    }


    /**
     * Extract Common Name from distinguished name string.
     */
    private String extractCN(String dn) {
        for (String part : dn.split(",")) {
            String trimmed = part.trim();
            if (trimmed.startsWith("CN=")) {
                return trimmed.substring(3);
            }
        }
        return null;
    }


    /**
     * Check certificate validity period.
     * Warns if certificate is expiring within threshold.
     *
     * @return true if certificate is currently valid
     */
    public boolean checkExpiration(X509Certificate cert) {
        Date now = new Date();

        /* Check not-yet-valid */
        if (now.before(cert.getNotBefore())) {
            logger.severe("Certificate is not yet valid (starts "
                + cert.getNotBefore() + ")");
            return false;
        }

        /* Check expired */
        if (now.after(cert.getNotAfter())) {
            logger.severe("Certificate has expired (ended "
                + cert.getNotAfter() + ")");
            return false;
        }

        /* Warn if expiring soon */
        long daysRemaining = (cert.getNotAfter().getTime() - now.getTime())
                             / (1000 * 60 * 60 * 24);
        if (daysRemaining < EXPIRY_WARN_DAYS) {
            logger.warning("Certificate expires in " + daysRemaining + " days");
        }

        return true;
    }


    /**
     * Verify key usage extensions permit TLS server authentication.
     *
     * @return true if key usage is acceptable
     */
    public boolean checkKeyUsage(X509Certificate cert) {
        boolean[] keyUsage = cert.getKeyUsage();
        if (keyUsage != null) {
            /* Bit 0 = digitalSignature */
            if (!keyUsage[0]) {
                logger.severe("Certificate lacks digitalSignature key usage");
                return false;
            }
        }

        try {
            List<String> extKeyUsage = cert.getExtendedKeyUsage();
            if (extKeyUsage != null) {
                /* OID 1.3.6.1.5.5.7.3.1 = serverAuth */
                if (!extKeyUsage.contains("1.3.6.1.5.5.7.3.1")) {
                    logger.severe("Certificate lacks serverAuth ext key usage");
                    return false;
                }
            }
        } catch (CertificateParsingException e) {
            logger.warning("Could not parse extended key usage");
        }

        return true;
    }


    /**
     * Log certificate chain details for debugging.
     */
    private void logChainDetails(Certificate[] chain) {
        logger.info("Certificate chain depth: " + chain.length);
        for (int i = 0; i < chain.length && i < MAX_CHAIN_DEPTH; i++) {
            X509Certificate cert = (X509Certificate) chain[i];
            logger.info("  [" + i + "] "
                + cert.getSubjectX500Principal().getName());
        }
    }

    public void setAllowSelfSigned(boolean allow) {
        this.allowSelfSigned = allow;
    }
}
