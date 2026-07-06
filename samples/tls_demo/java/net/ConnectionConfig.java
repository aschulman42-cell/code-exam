/*
 * ConnectionConfig.java - Secure Connection Configuration
 *
 * Holds parameters for establishing TLS connections including
 * certificate paths, cipher preferences, and timeout settings.
 *
 * Copyright (c) 2024 SecureNet Systems, Inc.
 */

package com.securenet.network;

public class ConnectionConfig {

    private String minTlsVersion = "TLSv1.2";
    private int minKeyBits = 128;
    private int timeoutMs = 10000;
    private String caCertPath = null;
    private String clientCertPath = null;
    private String clientCertPassword = null;
    private String trustStorePassword = "changeit";
    private boolean verifyHostname = true;
    private boolean allowSelfSigned = false;

    public ConnectionConfig() {}

    public String getMinTlsVersion() { return minTlsVersion; }
    public void setMinTlsVersion(String v) { this.minTlsVersion = v; }

    public int getMinKeyBits() { return minKeyBits; }
    public void setMinKeyBits(int bits) { this.minKeyBits = bits; }

    public int getTimeoutMs() { return timeoutMs; }
    public void setTimeoutMs(int ms) { this.timeoutMs = ms; }

    public String getCaCertPath() { return caCertPath; }
    public void setCaCertPath(String path) { this.caCertPath = path; }

    public String getClientCertPath() { return clientCertPath; }
    public void setClientCertPath(String path) { this.clientCertPath = path; }

    public String getClientCertPassword() { return clientCertPassword; }
    public void setClientCertPassword(String pw) { this.clientCertPassword = pw; }

    public String getTrustStorePassword() { return trustStorePassword; }
    public void setTrustStorePassword(String pw) { this.trustStorePassword = pw; }

    public boolean isVerifyHostname() { return verifyHostname; }
    public void setVerifyHostname(boolean v) { this.verifyHostname = v; }

    public boolean isAllowSelfSigned() { return allowSelfSigned; }
    public void setAllowSelfSigned(boolean v) { this.allowSelfSigned = v; }

    @Override
    public String toString() {
        return "ConnectionConfig{" +
            "minTlsVersion='" + minTlsVersion + '\'' +
            ", minKeyBits=" + minKeyBits +
            ", timeoutMs=" + timeoutMs +
            ", verifyHostname=" + verifyHostname +
            '}';
    }
}
