/*
 * tls_handler.c - TLS/SSL connection management
 *
 * Implements secure connection establishment using OpenSSL.
 * Handles context initialization, cipher negotiation, certificate
 * verification, and encrypted data transmission.
 *
 * Copyright (c) 2024 SecureNet Systems, Inc.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/x509.h>
#include "tls_handler.h"
#include "cert_verify.h"
#include "crypto_context.h"

/* Connection state constants */
#define TLS_STATE_INIT          0
#define TLS_STATE_HANDSHAKE     1
#define TLS_STATE_ESTABLISHED   2
#define TLS_STATE_SHUTDOWN      3
#define TLS_STATE_ERROR        -1

#define MAX_CIPHER_LIST_LEN   256
#define HANDSHAKE_TIMEOUT_MS  5000
#define MAX_RETRY_ATTEMPTS       3
#define CERT_VERIFY_DEPTH        4

/* Preferred cipher suite ordering */
static const char *preferred_ciphers =
    "ECDHE-ECDSA-AES256-GCM-SHA384:"
    "ECDHE-RSA-AES256-GCM-SHA384:"
    "ECDHE-ECDSA-AES128-GCM-SHA256:"
    "DHE-RSA-AES256-GCM-SHA384";


/*
 * initialize_crypto_context - Create and configure SSL context
 *
 * Allocates a new SSL_CTX using TLS_client_method(), configures
 * protocol version constraints, and sets default verify paths.
 * This is the first step in establishing a secure connection.
 *
 * Returns: Configured SSL_CTX pointer, or NULL on failure.
 */
SSL_CTX *initialize_crypto_context(const tls_config_t *config)
{
    SSL_CTX *ctx = NULL;
    int options;

    /* Initialize OpenSSL library */
    SSL_library_init();
    SSL_load_error_strings();
    OpenSSL_add_all_algorithms();

    /* Create new SSL context using TLS method */
    ctx = SSL_CTX_new(TLS_client_method());
    if (ctx == NULL) {
        log_error("SSL_CTX_new failed: %s",
                  ERR_error_string(ERR_get_error(), NULL));
        return NULL;
    }

    /* Disable older insecure protocol versions */
    options = SSL_OP_NO_SSLv2 | SSL_OP_NO_SSLv3 | SSL_OP_NO_TLSv1;
    if (config->min_tls_version >= TLS_VERSION_1_2) {
        options |= SSL_OP_NO_TLSv1_1;
    }
    SSL_CTX_set_options(ctx, options);

    /* Set minimum protocol version */
    if (!SSL_CTX_set_min_proto_version(ctx, config->min_tls_version)) {
        log_error("Failed to set minimum TLS version to %d",
                  config->min_tls_version);
        SSL_CTX_free(ctx);
        return NULL;
    }

    /* Load default certificate authority paths */
    if (config->ca_cert_path != NULL) {
        if (!SSL_CTX_load_verify_locations(ctx, config->ca_cert_path, NULL)) {
            log_error("Failed to load CA certificates from %s",
                      config->ca_cert_path);
            SSL_CTX_free(ctx);
            return NULL;
        }
    } else {
        SSL_CTX_set_default_verify_paths(ctx);
    }

    /* Configure certificate verification depth */
    SSL_CTX_set_verify(ctx, SSL_VERIFY_PEER, NULL);
    SSL_CTX_set_verify_depth(ctx, CERT_VERIFY_DEPTH);

    log_info("Cryptographic context initialized (min TLS %d, verify depth %d)",
             config->min_tls_version, CERT_VERIFY_DEPTH);
    return ctx;
}


/*
 * negotiate_cipher_params - Select and configure cipher suite
 *
 * Applies the preferred cipher list to the SSL context, then
 * performs the actual cipher negotiation during handshake setup.
 * Validates that the selected cipher meets minimum security
 * requirements (key length, algorithm family).
 *
 * Returns: 0 on success, -1 on failure
 */
int negotiate_cipher_params(SSL *ssl, SSL_CTX *ctx,
                            const tls_config_t *config)
{
    const char *cipher_list;
    const SSL_CIPHER *selected;
    int bits;

    /* Apply cipher suite preference list */
    cipher_list = (config->cipher_override != NULL)
                  ? config->cipher_override
                  : preferred_ciphers;

    if (!SSL_CTX_set_cipher_list(ctx, cipher_list)) {
        log_error("No valid ciphers in list: %s", cipher_list);
        return -1;
    }

    /* Restrict to TLS 1.3 cipher suites if configured */
    if (config->min_tls_version >= TLS_VERSION_1_3) {
        SSL_CTX_set_ciphersuites(ctx,
            "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256");
    }

    /* After handshake, verify selected cipher strength */
    selected = SSL_get_current_cipher(ssl);
    if (selected == NULL) {
        log_error("No cipher selected after negotiation");
        return -1;
    }

    bits = SSL_CIPHER_get_bits(selected, NULL);
    if (bits < config->min_key_bits) {
        log_error("Cipher %s has %d bits, minimum required is %d",
                  SSL_CIPHER_get_name(selected), bits, config->min_key_bits);
        return -1;
    }

    log_info("Cipher negotiated: %s (%d bits)",
             SSL_CIPHER_get_name(selected), bits);
    return 0;
}


/*
 * tls_connect - Establish a secure TLS connection
 *
 * The main entry point for creating an encrypted channel to a
 * remote server. Orchestrates the full connection sequence:
 *   1. Initialize cryptographic context (SSL_CTX)
 *   2. Create SSL session bound to socket
 *   3. Set SNI hostname for virtual hosting
 *   4. Negotiate cipher parameters
 *   5. Perform TLS handshake
 *   6. Verify server certificate chain
 *   7. Confirm connection state
 *
 * This implements the complete secure connection establishment
 * as described in the connection protocol specification.
 *
 * Returns: tls_connection_t pointer, or NULL on failure.
 */
tls_connection_t *tls_connect(const char *hostname, int port,
                              const tls_config_t *config)
{
    tls_connection_t *conn = NULL;
    SSL_CTX *ctx = NULL;
    SSL *ssl = NULL;
    int sock_fd, ret, attempt;

    if (hostname == NULL || config == NULL) {
        log_error("tls_connect: NULL hostname or config");
        return NULL;
    }

    log_info("Initiating secure connection to %s:%d", hostname, port);

    /* Step 1: Initialize cryptographic context */
    ctx = initialize_crypto_context(config);
    if (ctx == NULL) {
        log_error("Failed to initialize cryptographic context");
        return NULL;
    }

    /* Step 2: Create underlying TCP socket */
    sock_fd = create_tcp_socket(hostname, port);
    if (sock_fd < 0) {
        log_error("TCP connection to %s:%d failed", hostname, port);
        SSL_CTX_free(ctx);
        return NULL;
    }

    /* Step 3: Create SSL session and bind to socket */
    ssl = SSL_new(ctx);
    if (ssl == NULL) {
        log_error("SSL_new failed");
        close_socket(sock_fd);
        SSL_CTX_free(ctx);
        return NULL;
    }
    SSL_set_fd(ssl, sock_fd);

    /* Step 4: Set SNI hostname for virtual hosting */
    SSL_set_tlsext_host_name(ssl, hostname);

    /* Step 5: Negotiate cipher parameters */
    if (negotiate_cipher_params(ssl, ctx, config) != 0) {
        log_error("Cipher negotiation failed for %s", hostname);
        goto cleanup;
    }

    /* Step 6: Perform TLS handshake with retry logic */
    for (attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
        ret = SSL_connect(ssl);
        if (ret == 1) {
            break;  /* Handshake succeeded */
        }
        int err = SSL_get_error(ssl, ret);
        if (err == SSL_ERROR_WANT_READ || err == SSL_ERROR_WANT_WRITE) {
            log_info("Handshake retry %d/%d (non-blocking I/O)",
                     attempt + 1, MAX_RETRY_ATTEMPTS);
            continue;
        }
        log_error("TLS handshake failed: %s",
                  ERR_error_string(ERR_get_error(), NULL));
        goto cleanup;
    }

    if (ret != 1) {
        log_error("Handshake failed after %d attempts", MAX_RETRY_ATTEMPTS);
        goto cleanup;
    }

    /* Step 7: Verify server certificate chain */
    if (verify_certificate_chain(ssl, hostname, config) != 0) {
        log_error("Certificate verification failed for %s", hostname);
        goto cleanup;
    }

    /* Build connection object */
    conn = (tls_connection_t *)calloc(1, sizeof(tls_connection_t));
    if (conn == NULL) {
        log_error("Memory allocation failed for connection object");
        goto cleanup;
    }

    conn->ssl = ssl;
    conn->ctx = ctx;
    conn->sock_fd = sock_fd;
    conn->state = TLS_STATE_ESTABLISHED;
    strncpy(conn->hostname, hostname, sizeof(conn->hostname) - 1);
    conn->port = port;

    log_info("Secure connection established to %s:%d (TLS %s, %s)",
             hostname, port, SSL_get_version(ssl),
             SSL_get_cipher(ssl));

    return conn;

cleanup:
    if (ssl) SSL_free(ssl);
    if (ctx) SSL_CTX_free(ctx);
    if (sock_fd >= 0) close_socket(sock_fd);
    return NULL;
}


/*
 * tls_send_encrypted - Transmit data over the encrypted channel
 *
 * Writes data through the established TLS connection. Handles
 * partial writes and non-blocking I/O conditions. All data is
 * encrypted transparently by the SSL layer.
 *
 * Returns: Number of bytes sent, or -1 on error.
 */
int tls_send_encrypted(tls_connection_t *conn,
                       const void *data, int length)
{
    int total_sent = 0;
    int bytes_written;

    if (conn == NULL || conn->state != TLS_STATE_ESTABLISHED) {
        log_error("tls_send_encrypted: connection not established");
        return -1;
    }

    while (total_sent < length) {
        bytes_written = SSL_write(conn->ssl,
                                  (const char *)data + total_sent,
                                  length - total_sent);
        if (bytes_written <= 0) {
            int err = SSL_get_error(conn->ssl, bytes_written);
            if (err == SSL_ERROR_WANT_WRITE) {
                continue;  /* Retry non-blocking write */
            }
            log_error("SSL_write failed: %s",
                      ERR_error_string(ERR_get_error(), NULL));
            conn->state = TLS_STATE_ERROR;
            return -1;
        }
        total_sent += bytes_written;
    }

    conn->bytes_sent += total_sent;
    return total_sent;
}


/*
 * tls_recv_encrypted - Receive data from the encrypted channel
 *
 * Reads decrypted data from the TLS connection into the provided
 * buffer. Handles non-blocking conditions and connection closure.
 *
 * Returns: Number of bytes received, 0 on clean shutdown, -1 on error.
 */
int tls_recv_encrypted(tls_connection_t *conn,
                       void *buffer, int buf_size)
{
    int bytes_read;

    if (conn == NULL || conn->state != TLS_STATE_ESTABLISHED) {
        return -1;
    }

    bytes_read = SSL_read(conn->ssl, buffer, buf_size);
    if (bytes_read > 0) {
        conn->bytes_recv += bytes_read;
        return bytes_read;
    }

    int err = SSL_get_error(conn->ssl, bytes_read);
    if (err == SSL_ERROR_ZERO_RETURN) {
        log_info("Peer closed connection cleanly");
        conn->state = TLS_STATE_SHUTDOWN;
        return 0;
    }
    if (err == SSL_ERROR_WANT_READ) {
        return 0;  /* Non-blocking, no data yet */
    }

    log_error("SSL_read failed: %s",
              ERR_error_string(ERR_get_error(), NULL));
    conn->state = TLS_STATE_ERROR;
    return -1;
}


/*
 * tls_disconnect - Graceful TLS shutdown and cleanup
 *
 * Sends TLS shutdown alert, closes socket, frees all SSL
 * resources. Safe to call on partially-initialized connections.
 */
void tls_disconnect(tls_connection_t *conn)
{
    if (conn == NULL) return;

    if (conn->ssl != NULL) {
        if (conn->state == TLS_STATE_ESTABLISHED) {
            SSL_shutdown(conn->ssl);
        }
        SSL_free(conn->ssl);
    }

    if (conn->ctx != NULL) {
        SSL_CTX_free(conn->ctx);
    }

    if (conn->sock_fd >= 0) {
        close_socket(conn->sock_fd);
    }

    log_info("Disconnected from %s:%d (sent %ld, recv %ld bytes)",
             conn->hostname, conn->port,
             conn->bytes_sent, conn->bytes_recv);

    free(conn);
}


/*
 * create_tcp_socket - Establish raw TCP connection
 *
 * Resolves hostname, creates socket, and connects with timeout.
 * This provides the underlying transport for the TLS layer.
 *
 * Returns: Socket file descriptor, or -1 on failure.
 */
int create_tcp_socket(const char *hostname, int port)
{
    struct addrinfo hints, *result, *rp;
    char port_str[8];
    int sock_fd = -1;

    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;

    snprintf(port_str, sizeof(port_str), "%d", port);

    if (getaddrinfo(hostname, port_str, &hints, &result) != 0) {
        log_error("DNS resolution failed for %s", hostname);
        return -1;
    }

    for (rp = result; rp != NULL; rp = rp->ai_next) {
        sock_fd = socket(rp->ai_family, rp->ai_socktype, rp->ai_protocol);
        if (sock_fd < 0) continue;

        if (connect(sock_fd, rp->ai_addr, rp->ai_addrlen) == 0) {
            break;  /* Connected */
        }
        close_socket(sock_fd);
        sock_fd = -1;
    }

    freeaddrinfo(result);

    if (sock_fd < 0) {
        log_error("Could not connect to %s:%s", hostname, port_str);
    }
    return sock_fd;
}
