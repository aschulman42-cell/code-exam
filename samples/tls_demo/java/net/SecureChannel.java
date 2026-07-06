/*
 * SecureChannel.java - Encrypted Data Transmission Channel
 *
 * Manages bidirectional encrypted data flow over an established
 * TLS connection. Provides message framing, buffering, and
 * streaming interfaces for the encrypted channel.
 *
 * Copyright (c) 2024 SecureNet Systems, Inc.
 */

package com.securenet.network;

import javax.net.ssl.*;
import java.io.*;
import java.nio.ByteBuffer;
import java.util.logging.Logger;

public class SecureChannel {

    private static final Logger logger = Logger.getLogger(
        SecureChannel.class.getName());
    private static final int FRAME_HEADER_SIZE = 8;
    private static final int MAX_FRAME_SIZE = 16384;  /* TLS record limit */
    private static final int READ_BUFFER_SIZE = 32768;


    /**
     * Send a framed message over the encrypted channel.
     *
     * Wraps the payload in a length-prefixed frame and transmits
     * it through the SSL socket. The frame format is:
     *   [4 bytes: payload length] [4 bytes: message type] [payload]
     *
     * All data is encrypted transparently by the underlying TLS layer.
     *
     * @param socket   Established SSLSocket
     * @param msgType  Application-defined message type identifier
     * @param payload  Data to transmit over the encrypted channel
     * @return         Total bytes sent (including header), or -1 on error
     */
    public int sendMessage(SSLSocket socket, int msgType, byte[] payload) {
        if (socket == null || socket.isClosed()) {
            logger.warning("Cannot send: channel not established");
            return -1;
        }

        int payloadLen = (payload != null) ? payload.length : 0;

        try {
            OutputStream out = socket.getOutputStream();
            ByteBuffer header = ByteBuffer.allocate(FRAME_HEADER_SIZE);
            header.putInt(payloadLen);
            header.putInt(msgType);

            /* Write header */
            out.write(header.array());

            /* Write payload in chunks respecting TLS record size */
            if (payload != null && payloadLen > 0) {
                int offset = 0;
                while (offset < payloadLen) {
                    int chunkSize = Math.min(MAX_FRAME_SIZE,
                                             payloadLen - offset);
                    out.write(payload, offset, chunkSize);
                    offset += chunkSize;
                }
            }

            out.flush();
            int totalSent = FRAME_HEADER_SIZE + payloadLen;
            logger.fine("Sent message type=" + msgType + " len=" + payloadLen
                + " via encrypted channel");
            return totalSent;

        } catch (IOException e) {
            logger.severe("Error transmitting data over encrypted channel: "
                + e.getMessage());
            return -1;
        }
    }


    /**
     * Receive a framed message from the encrypted channel.
     *
     * Reads a length-prefixed frame from the SSL socket.
     * Decryption is handled transparently by the TLS layer.
     *
     * @param socket   Established SSLSocket
     * @return         Received message, or null on error/close
     */
    public ChannelMessage receiveMessage(SSLSocket socket) {
        if (socket == null || socket.isClosed()) {
            return null;
        }

        try {
            InputStream in = socket.getInputStream();

            /* Read frame header */
            byte[] headerBytes = readExact(in, FRAME_HEADER_SIZE);
            if (headerBytes == null) {
                return null;  /* Connection closed */
            }

            ByteBuffer header = ByteBuffer.wrap(headerBytes);
            int payloadLen = header.getInt();
            int msgType = header.getInt();

            /* Validate payload length */
            if (payloadLen < 0 || payloadLen > MAX_FRAME_SIZE * 16) {
                logger.severe("Invalid frame length: " + payloadLen);
                return null;
            }

            /* Read payload */
            byte[] payload = null;
            if (payloadLen > 0) {
                payload = readExact(in, payloadLen);
                if (payload == null) {
                    logger.severe("Connection closed mid-frame");
                    return null;
                }
            }

            logger.fine("Received message type=" + msgType
                + " len=" + payloadLen + " from encrypted channel");

            return new ChannelMessage(msgType, payload);

        } catch (IOException e) {
            logger.severe("Error receiving from encrypted channel: "
                + e.getMessage());
            return null;
        }
    }


    /**
     * Read exactly 'length' bytes from the input stream.
     * Handles partial reads from the TLS layer.
     */
    private byte[] readExact(InputStream in, int length) throws IOException {
        byte[] buffer = new byte[length];
        int totalRead = 0;
        while (totalRead < length) {
            int bytesRead = in.read(buffer, totalRead, length - totalRead);
            if (bytesRead < 0) {
                if (totalRead == 0) return null;
                throw new IOException("Unexpected end of stream after "
                    + totalRead + " of " + length + " bytes");
            }
            totalRead += bytesRead;
        }
        return buffer;
    }


    /**
     * Stream data from an InputStream through the encrypted channel.
     *
     * Reads data from the source stream in chunks and transmits
     * each chunk as a framed message. Useful for file transfers
     * and large payload streaming.
     *
     * @param socket    Established SSLSocket
     * @param source    Input stream to read from
     * @param msgType   Message type for all chunks
     * @return          Total bytes streamed, or -1 on error
     */
    public long streamData(SSLSocket socket, InputStream source,
                           int msgType) {
        byte[] buffer = new byte[MAX_FRAME_SIZE];
        long totalStreamed = 0;
        int bytesRead;

        try {
            while ((bytesRead = source.read(buffer)) >= 0) {
                byte[] chunk = (bytesRead == buffer.length)
                    ? buffer
                    : java.util.Arrays.copyOf(buffer, bytesRead);
                int sent = sendMessage(socket, msgType, chunk);
                if (sent < 0) {
                    return -1;
                }
                totalStreamed += bytesRead;
            }

            /* Send zero-length frame to signal end of stream */
            sendMessage(socket, msgType, new byte[0]);

            logger.info("Streamed " + totalStreamed
                + " bytes through encrypted channel");
            return totalStreamed;

        } catch (IOException e) {
            logger.severe("Stream error: " + e.getMessage());
            return -1;
        }
    }


    /**
     * Simple message container for received data.
     */
    public static class ChannelMessage {
        public final int type;
        public final byte[] payload;

        public ChannelMessage(int type, byte[] payload) {
            this.type = type;
            this.payload = payload;
        }

        public int getPayloadLength() {
            return (payload != null) ? payload.length : 0;
        }
    }
}
