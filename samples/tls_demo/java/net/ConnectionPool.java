/*
 * ConnectionPool.java - SSL Connection Pool Management
 *
 * Manages a pool of reusable SSL connections to avoid repeated
 * TLS handshake overhead. Supports connection health checking
 * and automatic cleanup of stale connections.
 *
 * Copyright (c) 2024 SecureNet Systems, Inc.
 */

package com.securenet.network;

import javax.net.ssl.SSLSocket;
import java.io.IOException;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Logger;

public class ConnectionPool {

    private static final Logger logger = Logger.getLogger(
        ConnectionPool.class.getName());
    private static final long IDLE_TIMEOUT_MS = 300000;  /* 5 minutes */

    private final int maxConnections;
    private final Map<String, PoolEntry> pool;


    public ConnectionPool(int maxConnections) {
        this.maxConnections = maxConnections;
        this.pool = new ConcurrentHashMap<>();
    }


    /**
     * Retrieve a pooled connection for the specified host.
     *
     * @return  Reusable SSLSocket, or null if none available
     */
    public SSLSocket checkout(String hostname, int port) {
        String key = hostname + ":" + port;
        PoolEntry entry = pool.get(key);

        if (entry == null) {
            return null;
        }

        synchronized (entry) {
            if (entry.socket == null || entry.socket.isClosed()) {
                pool.remove(key);
                return null;
            }

            long idleTime = System.currentTimeMillis() - entry.lastUsed;
            if (idleTime > IDLE_TIMEOUT_MS) {
                closeEntry(entry);
                pool.remove(key);
                logger.info("Evicted idle connection to " + key);
                return null;
            }

            entry.lastUsed = System.currentTimeMillis();
            entry.useCount++;
            logger.fine("Checked out pooled connection to " + key
                + " (use #" + entry.useCount + ")");
            return entry.socket;
        }
    }


    /**
     * Register a new connection in the pool.
     */
    public void register(String hostname, int port, SSLSocket socket) {
        String key = hostname + ":" + port;

        /* Evict existing connection for this host */
        PoolEntry existing = pool.get(key);
        if (existing != null) {
            closeEntry(existing);
        }

        /* Check pool capacity */
        if (pool.size() >= maxConnections) {
            evictOldest();
        }

        PoolEntry entry = new PoolEntry();
        entry.socket = socket;
        entry.hostname = hostname;
        entry.port = port;
        entry.lastUsed = System.currentTimeMillis();
        entry.created = System.currentTimeMillis();
        entry.useCount = 1;

        pool.put(key, entry);
        logger.info("Registered connection in pool: " + key
            + " (pool size: " + pool.size() + ")");
    }


    /**
     * Remove and close the oldest idle connection.
     */
    private void evictOldest() {
        String oldestKey = null;
        long oldestTime = Long.MAX_VALUE;

        for (Map.Entry<String, PoolEntry> entry : pool.entrySet()) {
            if (entry.getValue().lastUsed < oldestTime) {
                oldestTime = entry.getValue().lastUsed;
                oldestKey = entry.getKey();
            }
        }

        if (oldestKey != null) {
            PoolEntry evicted = pool.remove(oldestKey);
            if (evicted != null) {
                closeEntry(evicted);
                logger.info("Evicted oldest connection: " + oldestKey);
            }
        }
    }


    /**
     * Close all pooled connections.
     */
    public void closeAll() {
        for (Map.Entry<String, PoolEntry> entry : pool.entrySet()) {
            closeEntry(entry.getValue());
        }
        pool.clear();
        logger.info("Connection pool cleared");
    }


    /**
     * Get pool statistics.
     */
    public int getActiveCount() {
        return pool.size();
    }


    private void closeEntry(PoolEntry entry) {
        if (entry != null && entry.socket != null) {
            try {
                entry.socket.close();
            } catch (IOException ignored) {
            }
        }
    }


    private static class PoolEntry {
        SSLSocket socket;
        String hostname;
        int port;
        long created;
        long lastUsed;
        int useCount;
    }
}
