/*
 * crypto_context.c - Cryptographic context and session management
 *
 * Manages SSL context lifecycle, session caching, and
 * cryptographic resource pooling for connection reuse.
 *
 * Copyright (c) 2024 SecureNet Systems, Inc.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <openssl/ssl.h>
#include <openssl/rand.h>
#include "crypto_context.h"
#include "tls_handler.h"

#define MAX_CACHED_SESSIONS  128
#define SESSION_TIMEOUT_SEC  3600
#define ENTROPY_BYTES        32


/* Global session cache */
typedef struct session_entry {
    char           hostname[256];
    int            port;
    SSL_SESSION   *session;
    time_t         created;
    int            reuse_count;
} session_entry_t;

static session_entry_t session_cache[MAX_CACHED_SESSIONS];
static int             cache_count = 0;
static pthread_mutex_t cache_mutex = PTHREAD_MUTEX_INITIALIZER;


/*
 * init_crypto_subsystem - One-time initialization of OpenSSL
 *
 * Seeds the PRNG, registers cleanup handlers, and initializes
 * threading support. Must be called before any SSL operations.
 *
 * Returns: 0 on success, -1 on failure.
 */
int init_crypto_subsystem(void)
{
    unsigned char entropy[ENTROPY_BYTES];

    /* Seed random number generator */
    if (RAND_status() != 1) {
        if (RAND_bytes(entropy, ENTROPY_BYTES) != 1) {
            log_error("Failed to seed PRNG");
            return -1;
        }
    }

    /* Initialize OpenSSL library */
    SSL_library_init();
    SSL_load_error_strings();
    OpenSSL_add_all_algorithms();

    /* Initialize session cache */
    memset(session_cache, 0, sizeof(session_cache));
    cache_count = 0;

    log_info("Cryptographic subsystem initialized");
    return 0;
}


/*
 * create_context_with_session - Create SSL context with session reuse
 *
 * Creates a new SSL_CTX configured for session caching and
 * ticket-based resumption. Attempts to restore a cached session
 * for the target host to speed up the TLS handshake.
 *
 * Returns: Configured SSL_CTX, or NULL on failure.
 */
SSL_CTX *create_context_with_session(const char *hostname, int port,
                                     const tls_config_t *config)
{
    SSL_CTX *ctx;

    ctx = initialize_crypto_context(config);
    if (ctx == NULL) {
        return NULL;
    }

    /* Enable session caching */
    SSL_CTX_set_session_cache_mode(ctx, SSL_SESS_CACHE_CLIENT);
    SSL_CTX_sess_set_cache_size(ctx, MAX_CACHED_SESSIONS);
    SSL_CTX_set_timeout(ctx, SESSION_TIMEOUT_SEC);

    /* Enable session tickets for TLS 1.3 resumption */
    SSL_CTX_set_num_tickets(ctx, 2);

    log_info("Context created with session caching for %s:%d",
             hostname, port);
    return ctx;
}


/*
 * cache_session - Store SSL session for future reuse
 *
 * Saves the negotiated session parameters so subsequent
 * connections to the same host can skip the full handshake.
 * Evicts the oldest entry if the cache is full.
 *
 * Returns: 0 on success, -1 on failure.
 */
int cache_session(const char *hostname, int port, SSL *ssl)
{
    SSL_SESSION *session;
    int slot;

    session = SSL_get1_session(ssl);
    if (session == NULL) {
        return -1;
    }

    pthread_mutex_lock(&cache_mutex);

    /* Find existing entry or empty slot */
    slot = -1;
    for (int i = 0; i < MAX_CACHED_SESSIONS; i++) {
        if (session_cache[i].session == NULL) {
            slot = i;
            break;
        }
        if (strcmp(session_cache[i].hostname, hostname) == 0 &&
            session_cache[i].port == port) {
            /* Replace existing session for this host */
            SSL_SESSION_free(session_cache[i].session);
            slot = i;
            break;
        }
    }

    /* Evict oldest entry if full */
    if (slot < 0) {
        time_t oldest = time(NULL);
        slot = 0;
        for (int i = 0; i < MAX_CACHED_SESSIONS; i++) {
            if (session_cache[i].created < oldest) {
                oldest = session_cache[i].created;
                slot = i;
            }
        }
        SSL_SESSION_free(session_cache[slot].session);
    }

    /* Store new session */
    strncpy(session_cache[slot].hostname, hostname,
            sizeof(session_cache[slot].hostname) - 1);
    session_cache[slot].port = port;
    session_cache[slot].session = session;
    session_cache[slot].created = time(NULL);
    session_cache[slot].reuse_count = 0;

    if (slot >= cache_count) {
        cache_count = slot + 1;
    }

    pthread_mutex_unlock(&cache_mutex);

    log_info("Session cached for %s:%d", hostname, port);
    return 0;
}


/*
 * restore_session - Retrieve cached session for connection reuse
 *
 * Looks up a previously cached SSL session for the target host.
 * Returns NULL if no valid session exists (expired or not cached).
 *
 * Returns: SSL_SESSION pointer (caller must NOT free), or NULL.
 */
SSL_SESSION *restore_session(const char *hostname, int port)
{
    SSL_SESSION *session = NULL;
    time_t now = time(NULL);

    pthread_mutex_lock(&cache_mutex);

    for (int i = 0; i < cache_count; i++) {
        if (session_cache[i].session != NULL &&
            strcmp(session_cache[i].hostname, hostname) == 0 &&
            session_cache[i].port == port) {

            /* Check if session has expired */
            if (now - session_cache[i].created > SESSION_TIMEOUT_SEC) {
                SSL_SESSION_free(session_cache[i].session);
                session_cache[i].session = NULL;
                log_info("Cached session expired for %s:%d", hostname, port);
                break;
            }

            session = session_cache[i].session;
            session_cache[i].reuse_count++;
            log_info("Restoring cached session for %s:%d (reuse #%d)",
                     hostname, port, session_cache[i].reuse_count);
            break;
        }
    }

    pthread_mutex_unlock(&cache_mutex);
    return session;
}


/*
 * cleanup_crypto_subsystem - Release all cryptographic resources
 *
 * Frees cached sessions, cleans up OpenSSL global state.
 * Must be called at program exit.
 */
void cleanup_crypto_subsystem(void)
{
    pthread_mutex_lock(&cache_mutex);

    for (int i = 0; i < cache_count; i++) {
        if (session_cache[i].session != NULL) {
            SSL_SESSION_free(session_cache[i].session);
            session_cache[i].session = NULL;
        }
    }
    cache_count = 0;

    pthread_mutex_unlock(&cache_mutex);

    EVP_cleanup();
    ERR_free_strings();

    log_info("Cryptographic subsystem cleaned up");
}
