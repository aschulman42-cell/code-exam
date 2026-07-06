/*
 * NetworkManager.java - Secure network connection lifecycle management
 *
 * Orchestrates secure connection establishment, data transmission,
 * and connection pooling. Serves as the primary entry point for
 * all network operations in the application.
 *
 * Copyright (c) 2024 SecureNet Systems, Inc.
 */

package com.securenet.network;

import javax.net.ssl.*;
import java.security.*;
import java.io.*;
import java.net.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.logging.Logger;

public class NetworkManager {

    private static final Logger logger = Logger.getLogger(NetworkManager.class.getName());
    private static final int DEFAULT_TIMEOUT_MS = 10000;
    private static final int MAX_CONNECTIONS = 50;
    private static final int RETRY_DELAY_MS = 1000;
    private static final int MAX_RETRIES = 3;

    private final ConnectionPool connectionPool;
    private final CipherNegotiator cipherNegotiator;
    private final CertificateValidator certValidator;
    private final SecureChannel secureChannel;
    private final ExecutorService executor;
    private volatile boolean shutdown = false;


    /**
     * Construct a new NetworkManager with default settings.
     * Initializes the connection pool, cipher negotiation engine,
     * certificate validator, and secure channel handler.
     */
    public NetworkManager() {
        this.connectionPool = new ConnectionPool(MAX_CONNECTIONS);
        this.cipherNegotiator = new CipherNegotiator();
        this.certValidator = new CertificateValidator();
        this.secureChannel = new SecureChannel();
        this.executor = Executors.newFixedThreadPool(
            Runtime.getRuntime().availableProcessors());
        logger.info("NetworkManager initialized");
    }


    /**
     * Establish a secure connection to the specified host.
     *
     * Orchestrates the full secure connection lifecycle:
     *   1. Check connection pool for reusable connection
     *   2. Initialize SSL context with configured parameters
     *   3. Create socket and perform TCP handshake
     *   4. Negotiate cipher suite via CipherNegotiator
     *   5. Execute TLS handshake
     *   6. Validate server certificate chain
     *   7. Register connection in pool
     *
     * This is the primary entry point for establishing encrypted
     * communication channels.
     *
     * @param hostname  Target server hostname
     * @param port      Target server port
     * @param config    Connection configuration parameters
     * @return          Established SSLSocket, or null on failure
     */
    public SSLSocket establishConnection(String hostname, int port,
                                         ConnectionConfig config) {
        if (shutdown) {
            logger.warning("NetworkManager is shutting down, rejecting connection");
            return null;
        }

        /* Step 1: Check pool for existing connection */
        SSLSocket pooled = connectionPool.checkout(hostname, port);
        if (pooled != null && isConnectionHealthy(pooled)) {
            logger.info("Reusing pooled connection to " + hostname + ":" + port);
            return pooled;
        }

        SSLSocket socket = null;
        int attempt = 0;

        while (attempt < MAX_RETRIES && socket == null) {
            attempt++;
            try {
                /* Step 2: Initialize SSL context */
                SSLContext sslContext = initializeSSLContext(config);
                if (sslContext == null) {
                    logger.severe("Failed to initialize SSL context");
                    return null;
                }

                /* Step 3: Create socket factory and connect */
                SSLSocketFactory factory = sslContext.getSocketFactory();
                socket = (SSLSocket) factory.createSocket();
                socket.connect(new InetSocketAddress(hostname, port),
                               config.getTimeoutMs());

                /* Step 4: Configure cipher suites */
                String[] ciphers = cipherNegotiator.selectCipherSuites(
                    socket.getSupportedCipherSuites(),
                    config.getMinKeyBits());
                socket.setEnabledCipherSuites(ciphers);

                /* Step 5: Configure TLS versions */
                String[] protocols = filterProtocols(
                    socket.getSupportedProtocols(),
                    config.getMinTlsVersion());
                socket.setEnabledProtocols(protocols);

                /* Step 6: Perform TLS handshake */
                socket.setSoTimeout(config.getTimeoutMs());
                socket.startHandshake();

                /* Step 7: Validate certificate chain */
                SSLSession session = socket.getSession();
                if (!certValidator.validateCertificateChain(
                        session, hostname)) {
                    logger.severe("Certificate validation failed for " + hostname);
                    socket.close();
                    socket = null;
                    continue;
                }

                /* Step 8: Register in connection pool */
                connectionPool.register(hostname, port, socket);

                logger.info("Secure connection established to " + hostname
                    + ":" + port + " using " + session.getProtocol()
                    + " " + session.getCipherSuite());

            } catch (SSLHandshakeException e) {
                logger.warning("Handshake failed (attempt " + attempt
                    + "/" + MAX_RETRIES + "): " + e.getMessage());
                closeQuietly(socket);
                socket = null;
                if (attempt < MAX_RETRIES) {
                    sleep(RETRY_DELAY_MS * attempt);
                }
            } catch (IOException e) {
                logger.warning("Connection failed (attempt " + attempt
                    + "/" + MAX_RETRIES + "): " + e.getMessage());
                closeQuietly(socket);
                socket = null;
                if (attempt < MAX_RETRIES) {
                    sleep(RETRY_DELAY_MS * attempt);
                }
            }
        }

        return socket;
    }


    /**
     * Send data over an established secure connection.
     *
     * Encrypts and transmits the provided data through the SSL
     * socket. Handles partial writes and connection errors.
     *
     * @param socket  Established SSLSocket
     * @param data    Data bytes to transmit
     * @return        Number of bytes sent, or -1 on error
     */
    public int sendSecureData(SSLSocket socket, byte[] data) {
        if (socket == null || socket.isClosed()) {
            logger.warning("Cannot send: socket is null or closed");
            return -1;
        }

        try {
            OutputStream out = socket.getOutputStream();
            out.write(data);
            out.flush();
            logger.fine("Sent " + data.length + " bytes to "
                + socket.getInetAddress().getHostName());
            return data.length;
        } catch (IOException e) {
            logger.severe("Send failed: " + e.getMessage());
            return -1;
        }
    }


    /**
     * Receive data from a secure connection.
     *
     * Reads decrypted data from the SSL socket into a buffer.
     *
     * @param socket    Established SSLSocket
     * @param bufSize   Maximum bytes to read
     * @return          Received data, or null on error
     */
    public byte[] receiveSecureData(SSLSocket socket, int bufSize) {
        if (socket == null || socket.isClosed()) {
            return null;
        }

        try {
            InputStream in = socket.getInputStream();
            byte[] buffer = new byte[bufSize];
            int bytesRead = in.read(buffer);
            if (bytesRead < 0) {
                return null;  /* Connection closed */
            }
            return Arrays.copyOf(buffer, bytesRead);
        } catch (IOException e) {
            logger.severe("Receive failed: " + e.getMessage());
            return null;
        }
    }


    /**
     * Initialize SSL context with key stores and trust stores.
     *
     * Creates an SSLContext configured with the application's
     * certificate chain (for mutual TLS) and trusted CA certificates.
     */
    private SSLContext initializeSSLContext(ConnectionConfig config) {
        try {
            SSLContext ctx = SSLContext.getInstance("TLS");

            KeyManager[] keyManagers = null;
            if (config.getClientCertPath() != null) {
                KeyStore keyStore = KeyStore.getInstance("PKCS12");
                try (FileInputStream fis = new FileInputStream(
                        config.getClientCertPath())) {
                    keyStore.load(fis,
                        config.getClientCertPassword().toCharArray());
                }
                KeyManagerFactory kmf = KeyManagerFactory.getInstance(
                    KeyManagerFactory.getDefaultAlgorithm());
                kmf.init(keyStore,
                    config.getClientCertPassword().toCharArray());
                keyManagers = kmf.getKeyManagers();
            }

            TrustManager[] trustManagers = null;
            if (config.getCaCertPath() != null) {
                KeyStore trustStore = KeyStore.getInstance("JKS");
                try (FileInputStream fis = new FileInputStream(
                        config.getCaCertPath())) {
                    trustStore.load(fis,
                        config.getTrustStorePassword().toCharArray());
                }
                TrustManagerFactory tmf = TrustManagerFactory.getInstance(
                    TrustManagerFactory.getDefaultAlgorithm());
                tmf.init(trustStore);
                trustManagers = tmf.getTrustManagers();
            }

            ctx.init(keyManagers, trustManagers, new SecureRandom());
            return ctx;

        } catch (Exception e) {
            logger.severe("SSL context initialization failed: " + e.getMessage());
            return null;
        }
    }


    /**
     * Filter protocols to enforce minimum TLS version.
     */
    private String[] filterProtocols(String[] supported, String minVersion) {
        List<String> filtered = new ArrayList<>();
        boolean include = false;
        String[] ordered = {"TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"};

        for (String proto : ordered) {
            if (proto.equals(minVersion)) include = true;
            if (include) {
                for (String s : supported) {
                    if (s.equals(proto)) filtered.add(proto);
                }
            }
        }
        return filtered.toArray(new String[0]);
    }


    /**
     * Check if a pooled connection is still usable.
     */
    private boolean isConnectionHealthy(SSLSocket socket) {
        try {
            return socket != null && !socket.isClosed()
                && socket.isConnected() && !socket.isInputShutdown();
        } catch (Exception e) {
            return false;
        }
    }


    /**
     * Close a socket without throwing exceptions.
     */
    private void closeQuietly(SSLSocket socket) {
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }

    private void sleep(int ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }


    /**
     * Graceful shutdown of all managed connections.
     */
    public void shutdown() {
        shutdown = true;
        connectionPool.closeAll();
        executor.shutdown();
        try {
            executor.awaitTermination(5, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            executor.shutdownNow();
        }
        logger.info("NetworkManager shutdown complete");
    }
}
