/*
 * buffer_pool.c - Memory buffer management for network I/O
 *
 * Provides pre-allocated buffer pools to avoid frequent malloc/free
 * during high-throughput encrypted data transmission.
 *
 * Copyright (c) 2024 SecureNet Systems, Inc.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include "buffer_pool.h"

#define DEFAULT_POOL_SIZE     64
#define DEFAULT_BUFFER_SIZE   8192
#define MAX_POOL_SIZE         1024

typedef struct buffer_node {
    unsigned char      *data;
    int                 size;
    int                 used;
    struct buffer_node *next;
} buffer_node_t;

typedef struct buffer_pool {
    buffer_node_t  *free_list;
    buffer_node_t  *active_list;
    int             buffer_size;
    int             total_allocated;
    int             total_in_use;
    pthread_mutex_t lock;
} buffer_pool_t;

static buffer_pool_t *global_pool = NULL;


/*
 * init_buffer_pool - Create a pre-allocated buffer pool
 *
 * Allocates pool_size buffers of buf_size bytes each.
 * All buffers start on the free list ready for checkout.
 *
 * Returns: 0 on success, -1 on failure.
 */
int init_buffer_pool(int pool_size, int buf_size)
{
    int i;

    if (pool_size <= 0) pool_size = DEFAULT_POOL_SIZE;
    if (buf_size <= 0)  buf_size = DEFAULT_BUFFER_SIZE;
    if (pool_size > MAX_POOL_SIZE) pool_size = MAX_POOL_SIZE;

    global_pool = (buffer_pool_t *)calloc(1, sizeof(buffer_pool_t));
    if (global_pool == NULL) {
        return -1;
    }

    pthread_mutex_init(&global_pool->lock, NULL);
    global_pool->buffer_size = buf_size;
    global_pool->free_list = NULL;
    global_pool->active_list = NULL;
    global_pool->total_allocated = 0;

    for (i = 0; i < pool_size; i++) {
        buffer_node_t *node = (buffer_node_t *)calloc(1, sizeof(buffer_node_t));
        if (node == NULL) break;

        node->data = (unsigned char *)malloc(buf_size);
        if (node->data == NULL) {
            free(node);
            break;
        }

        node->size = buf_size;
        node->used = 0;
        node->next = global_pool->free_list;
        global_pool->free_list = node;
        global_pool->total_allocated++;
    }

    log_info("Buffer pool initialized: %d buffers of %d bytes",
             global_pool->total_allocated, buf_size);
    return 0;
}


/*
 * pool_checkout - Get a buffer from the pool
 *
 * Returns a buffer from the free list. If the pool is
 * exhausted, allocates a new buffer (up to MAX_POOL_SIZE).
 *
 * Returns: Buffer pointer, or NULL if allocation fails.
 */
unsigned char *pool_checkout(int *out_size)
{
    buffer_node_t *node;

    if (global_pool == NULL) return NULL;

    pthread_mutex_lock(&global_pool->lock);

    if (global_pool->free_list != NULL) {
        node = global_pool->free_list;
        global_pool->free_list = node->next;
    } else if (global_pool->total_allocated < MAX_POOL_SIZE) {
        /* Grow pool */
        node = (buffer_node_t *)calloc(1, sizeof(buffer_node_t));
        if (node != NULL) {
            node->data = (unsigned char *)malloc(global_pool->buffer_size);
            if (node->data == NULL) {
                free(node);
                node = NULL;
            } else {
                node->size = global_pool->buffer_size;
                global_pool->total_allocated++;
            }
        }
    } else {
        node = NULL;
    }

    if (node != NULL) {
        node->used = 0;
        node->next = global_pool->active_list;
        global_pool->active_list = node;
        global_pool->total_in_use++;

        if (out_size) *out_size = node->size;
    }

    pthread_mutex_unlock(&global_pool->lock);

    return (node != NULL) ? node->data : NULL;
}


/*
 * pool_checkin - Return a buffer to the pool
 *
 * Moves the buffer from the active list back to the free list.
 * The buffer contents are zeroed for security (prevent data leaks
 * in encrypted communication buffers).
 */
void pool_checkin(unsigned char *buf)
{
    buffer_node_t *node, *prev;

    if (global_pool == NULL || buf == NULL) return;

    pthread_mutex_lock(&global_pool->lock);

    /* Find node in active list */
    prev = NULL;
    for (node = global_pool->active_list; node != NULL;
         prev = node, node = node->next) {
        if (node->data == buf) {
            /* Remove from active list */
            if (prev != NULL) {
                prev->next = node->next;
            } else {
                global_pool->active_list = node->next;
            }

            /* Zero buffer for security */
            memset(node->data, 0, node->size);
            node->used = 0;

            /* Add to free list */
            node->next = global_pool->free_list;
            global_pool->free_list = node;
            global_pool->total_in_use--;

            break;
        }
    }

    pthread_mutex_unlock(&global_pool->lock);
}


/*
 * pool_stats - Report buffer pool utilization
 */
void pool_stats(int *total, int *in_use, int *buf_size)
{
    if (global_pool == NULL) {
        if (total) *total = 0;
        if (in_use) *in_use = 0;
        if (buf_size) *buf_size = 0;
        return;
    }

    if (total) *total = global_pool->total_allocated;
    if (in_use) *in_use = global_pool->total_in_use;
    if (buf_size) *buf_size = global_pool->buffer_size;
}


/*
 * destroy_buffer_pool - Free all pool resources
 */
void destroy_buffer_pool(void)
{
    buffer_node_t *node, *next;

    if (global_pool == NULL) return;

    pthread_mutex_lock(&global_pool->lock);

    /* Free active buffers */
    for (node = global_pool->active_list; node != NULL; node = next) {
        next = node->next;
        memset(node->data, 0, node->size);
        free(node->data);
        free(node);
    }

    /* Free idle buffers */
    for (node = global_pool->free_list; node != NULL; node = next) {
        next = node->next;
        free(node->data);
        free(node);
    }

    pthread_mutex_unlock(&global_pool->lock);
    pthread_mutex_destroy(&global_pool->lock);

    free(global_pool);
    global_pool = NULL;

    log_info("Buffer pool destroyed");
}
