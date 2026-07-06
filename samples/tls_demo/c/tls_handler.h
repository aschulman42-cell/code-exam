/*
 * tls_handler.h - TLS connection management interface
 *
 * Public API for establishing and managing secure TLS connections.
 */

#ifndef TLS_HANDLER_H
#define TLS_HANDLER_H

#include <openssl/ssl.h>

/* TLS version constants */
#define TLS_VERSION_1_0  0x0301
#define TLS_VERSION_1_1  0x0302
#define TLS_VERSION_1_2  0x0303
#define TLS_VERSION_1_3  0x0304

/* Connection configuration */
typedef struct tls_config {
    int    min_tls_version;     /* Minimum acceptable TLS version */
    int    min_key_bits;        /* Minimum cipher key length */
    char  *ca_cert_path;        /* Path to CA certificate bundle */
    char  *client_cert_path;    /* Path to client certificate (mTLS) */
    char  *client_key_path;     /* Path to client private key */
    char  *cipher_override;     /* Custom cipher list (NULL = default) */
    int    verify_hostname;     /* Enable hostname verification */
    int    allow_self_signed;   /* Accept self-signed certificates */
} tls_config_t;

/* Connection state object */
typedef struct tls_connection {
    SSL       *ssl;
    SSL_CTX   *ctx;
    int        sock_fd;
    int        state;
    char       hostname[256];
    int        port;
    long       bytes_sent;
    long       bytes_recv;
} tls_connection_t;

/* Public API */
SSL_CTX            *initialize_crypto_context(const tls_config_t *config);
int                 negotiate_cipher_params(SSL *ssl, SSL_CTX *ctx,
                                            const tls_config_t *config);
tls_connection_t   *tls_connect(const char *hostname, int port,
                                const tls_config_t *config);
int                 tls_send_encrypted(tls_connection_t *conn,
                                       const void *data, int length);
int                 tls_recv_encrypted(tls_connection_t *conn,
                                       void *buffer, int buf_size);
void                tls_disconnect(tls_connection_t *conn);
int                 create_tcp_socket(const char *hostname, int port);

#endif /* TLS_HANDLER_H */
