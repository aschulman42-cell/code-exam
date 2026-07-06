/*
 * demo_main.c - Demo application entry point
 *
 * Demonstrates a basic TLS client workflow:
 *   1. Initialize crypto subsystem and buffer pool
 *   2. Connect to a remote host using TLS
 *   3. Send a request and receive a response
 *   4. Verify connection details
 *   5. Disconnect and clean up
 *
 * Copyright (c) 2024 SecureNet Systems, Inc.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "tls_handler.h"
#include "cert_verify.h"
#include "utils/logging.h"
#include "utils/buffer_pool.h"
#include "crypto_context.h"

#define DEFAULT_PORT    443
#define BUFFER_SIZE     4096

static void print_usage(const char *program) {
    fprintf(stderr, "Usage: %s <hostname> [port]\n", program);
    fprintf(stderr, "  hostname   Target server hostname\n");
    fprintf(stderr, "  port       TLS port (default: %d)\n", DEFAULT_PORT);
}

static int run_tls_client(const char *hostname, int port,
                          const tls_config_t *config) {
    tls_connection_t *conn;
    unsigned char *send_buf, *recv_buf;
    int send_size, recv_size;
    int bytes_sent, bytes_recv;

    /* Step 1: Establish secure connection */
    log_info("Connecting to %s:%d", hostname, port);
    conn = tls_connect(hostname, port, config);
    if (conn == NULL) {
        log_error("Failed to establish TLS connection to %s:%d",
                  hostname, port);
        return -1;
    }

    /* Step 2: Allocate buffers from pool */
    send_buf = pool_checkout(&send_size);
    recv_buf = pool_checkout(&recv_size);
    if (send_buf == NULL || recv_buf == NULL) {
        log_error("Buffer pool exhausted");
        tls_disconnect(conn);
        return -1;
    }

    /* Step 3: Send HTTP GET request */
    int req_len = snprintf((char *)send_buf, send_size,
        "GET / HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Connection: close\r\n"
        "\r\n", hostname);

    bytes_sent = tls_send_encrypted(conn, send_buf, req_len);
    if (bytes_sent < 0) {
        log_error("Failed to send request");
        goto cleanup;
    }
    log_info("Sent %d bytes", bytes_sent);

    /* Step 4: Receive response */
    bytes_recv = tls_recv_encrypted(conn, recv_buf, recv_size - 1);
    if (bytes_recv > 0) {
        recv_buf[bytes_recv] = '\0';
        log_info("Received %d bytes", bytes_recv);
        printf("--- Response (first 256 bytes) ---\n");
        printf("%.256s\n", (char *)recv_buf);
        printf("---\n");
    } else {
        log_warn("No response received");
    }

cleanup:
    pool_checkin(send_buf);
    pool_checkin(recv_buf);
    tls_disconnect(conn);
    return (bytes_recv > 0) ? 0 : -1;
}

int main(int argc, char *argv[]) {
    const char *hostname;
    int port = DEFAULT_PORT;
    tls_config_t config;
    int result;

    if (argc < 2) {
        print_usage(argv[0]);
        return 1;
    }

    hostname = argv[1];
    if (argc >= 3) {
        port = atoi(argv[2]);
        if (port <= 0 || port > 65535) {
            fprintf(stderr, "Invalid port: %s\n", argv[2]);
            return 1;
        }
    }

    /* Initialize subsystems */
    log_init("securenet.log", 3);
    log_info("SecureNet TLS Client starting");

    if (init_crypto_subsystem() != 0) {
        log_error("Crypto subsystem initialization failed");
        return 1;
    }

    if (init_buffer_pool(16, BUFFER_SIZE) != 0) {
        log_error("Buffer pool initialization failed");
        cleanup_crypto_subsystem();
        return 1;
    }

    /* Configure TLS connection */
    memset(&config, 0, sizeof(config));
    config.min_key_bits = 128;
    config.verify_hostname = 1;
    config.ca_cert_path = "/etc/ssl/certs/ca-certificates.crt";

    /* Run the client */
    result = run_tls_client(hostname, port, &config);

    /* Cleanup */
    destroy_buffer_pool();
    cleanup_crypto_subsystem();
    log_info("SecureNet TLS Client finished (result=%d)", result);
    log_close();

    return (result == 0) ? 0 : 1;
}
