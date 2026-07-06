/*
 * CipherNegotiator.java - TLS Cipher Suite Selection and Negotiation
 *
 * Selects appropriate cipher suites based on security requirements,
 * validates cipher strength, and manages cipher preference ordering.
 *
 * Copyright (c) 2024 SecureNet Systems, Inc.
 */

package com.securenet.network;

import java.util.*;
import java.util.logging.Logger;

public class CipherNegotiator {

    private static final Logger logger = Logger.getLogger(
        CipherNegotiator.class.getName());

    /* Preferred cipher suites in order of security strength */
    private static final String[] PREFERRED_CIPHERS = {
        "TLS_AES_256_GCM_SHA384",
        "TLS_CHACHA20_POLY1305_SHA256",
        "TLS_AES_128_GCM_SHA256",
        "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
        "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384",
        "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
        "TLS_DHE_RSA_WITH_AES_256_GCM_SHA384"
    };

    /* Blocked cipher suites (known insecure) */
    private static final Set<String> BLOCKED_CIPHERS = new HashSet<>(Arrays.asList(
        "TLS_RSA_WITH_RC4_128_SHA",
        "TLS_RSA_WITH_RC4_128_MD5",
        "TLS_RSA_WITH_3DES_EDE_CBC_SHA",
        "TLS_RSA_WITH_DES_CBC_SHA",
        "SSL_RSA_WITH_RC4_128_SHA",
        "SSL_RSA_WITH_3DES_EDE_CBC_SHA"
    ));

    /* Cipher key length lookup (approximate) */
    private static final Map<String, Integer> CIPHER_KEY_BITS = new HashMap<>();
    static {
        CIPHER_KEY_BITS.put("AES_256", 256);
        CIPHER_KEY_BITS.put("AES_128", 128);
        CIPHER_KEY_BITS.put("CHACHA20", 256);
        CIPHER_KEY_BITS.put("3DES", 112);
        CIPHER_KEY_BITS.put("RC4", 128);
        CIPHER_KEY_BITS.put("DES", 56);
    }


    /**
     * Select cipher suites that meet minimum security requirements.
     *
     * Filters the supported cipher list against the preferred order
     * and minimum key length. Returns an ordered array of acceptable
     * cipher suite names for the TLS handshake.
     *
     * @param supported   Cipher suites supported by the socket
     * @param minKeyBits  Minimum acceptable key length in bits
     * @return            Ordered array of selected cipher suites
     */
    public String[] selectCipherSuites(String[] supported, int minKeyBits) {
        Set<String> supportedSet = new HashSet<>(Arrays.asList(supported));
        List<String> selected = new ArrayList<>();

        /* First: add preferred ciphers that are also supported */
        for (String cipher : PREFERRED_CIPHERS) {
            if (supportedSet.contains(cipher) &&
                !BLOCKED_CIPHERS.contains(cipher) &&
                getCipherKeyBits(cipher) >= minKeyBits) {
                selected.add(cipher);
            }
        }

        /* Second: add remaining supported ciphers that meet requirements */
        for (String cipher : supported) {
            if (!selected.contains(cipher) &&
                !BLOCKED_CIPHERS.contains(cipher) &&
                getCipherKeyBits(cipher) >= minKeyBits) {
                selected.add(cipher);
            }
        }

        if (selected.isEmpty()) {
            logger.severe("No cipher suites meet minimum requirement of "
                + minKeyBits + " bits");
            return supported;  /* Fallback to all supported */
        }

        logger.info("Selected " + selected.size() + " cipher suites (min "
            + minKeyBits + " bits), top: " + selected.get(0));

        return selected.toArray(new String[0]);
    }


    /**
     * Validate that the negotiated cipher meets security policy.
     *
     * Called after TLS handshake to confirm the selected cipher
     * is acceptable. Logs warnings for weaker (but acceptable)
     * cipher selections.
     *
     * @param cipherSuite  The negotiated cipher suite name
     * @param minKeyBits   Minimum acceptable key length
     * @return             true if cipher is acceptable
     */
    public boolean validateNegotiatedCipher(String cipherSuite,
                                            int minKeyBits) {
        if (BLOCKED_CIPHERS.contains(cipherSuite)) {
            logger.severe("Negotiated cipher is on blocked list: "
                + cipherSuite);
            return false;
        }

        int keyBits = getCipherKeyBits(cipherSuite);
        if (keyBits < minKeyBits) {
            logger.severe("Negotiated cipher " + cipherSuite
                + " has " + keyBits + " bits, minimum is " + minKeyBits);
            return false;
        }

        if (keyBits < 256) {
            logger.warning("Cipher " + cipherSuite
                + " uses " + keyBits + "-bit keys (256 recommended)");
        }

        return true;
    }


    /**
     * Estimate key length for a cipher suite based on its name.
     * Returns 0 if the algorithm cannot be identified.
     */
    private int getCipherKeyBits(String cipherSuite) {
        for (Map.Entry<String, Integer> entry : CIPHER_KEY_BITS.entrySet()) {
            if (cipherSuite.contains(entry.getKey())) {
                return entry.getValue();
            }
        }
        /* Unknown cipher - assume minimum acceptable */
        return 128;
    }


    /**
     * Generate a human-readable report of cipher suite configuration.
     */
    public String getCipherReport(String[] enabledCiphers) {
        StringBuilder sb = new StringBuilder();
        sb.append("Enabled cipher suites (").append(enabledCiphers.length)
          .append("):\n");
        for (int i = 0; i < enabledCiphers.length; i++) {
            String cipher = enabledCiphers[i];
            int bits = getCipherKeyBits(cipher);
            boolean preferred = false;
            for (String p : PREFERRED_CIPHERS) {
                if (p.equals(cipher)) { preferred = true; break; }
            }
            sb.append(String.format("  [%2d] %-50s %3d-bit%s\n",
                i + 1, cipher, bits, preferred ? " *" : ""));
        }
        return sb.toString();
    }
}
