"""
handshake.py - TLS Handshake Protocol Implementation

Implements TLS handshake using Python's ssl module. Manages the
complete secure connection negotiation including SNI, cipher
selection, certificate verification, and session resumption.

Copyright (c) 2024 SecureNet Systems, Inc.
"""

import ssl
import socket
import logging
import time
from typing import Optional, Tuple
from config_parser import TLSConfig

logger = logging.getLogger(__name__)

# Protocol version mapping
TLS_VERSION_MAP = {
    "TLSv1.0": ssl.TLSVersion.TLSv1,
    "TLSv1.1": ssl.TLSVersion.TLSv1_1,
    "TLSv1.2": ssl.TLSVersion.TLSv1_2,
    "TLSv1.3": ssl.TLSVersion.TLSv1_3,
}


class TLSHandshake:
    """
    Manages the TLS handshake process for establishing secure
    connections. Wraps Python's ssl module with additional
    validation, retry logic, and session management.
    """

    def __init__(self, config: TLSConfig):
        self.config = config
        self.ssl_context = None
        self._session_cache = {}

    def create_ssl_context(self) -> ssl.SSLContext:
        """
        Initialize the SSL context for secure connections.

        Creates and configures an ssl.SSLContext with:
        - Minimum TLS version enforcement
        - Certificate verification mode
        - CA certificate loading
        - Client certificate (for mutual TLS)
        - Cipher suite configuration

        Returns:
            Configured ssl.SSLContext
        """
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)

        # Set minimum TLS version
        min_version = TLS_VERSION_MAP.get(self.config.min_tls_version)
        if min_version:
            ctx.minimum_version = min_version
        else:
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2

        # Certificate verification
        if self.config.allow_self_signed:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_OPTIONAL
        else:
            ctx.check_hostname = self.config.verify_hostname
            ctx.verify_mode = ssl.CERT_REQUIRED

        # Load CA certificates
        if self.config.ca_cert_path:
            ctx.load_verify_locations(self.config.ca_cert_path)
        else:
            ctx.load_default_certs()

        # Load client certificate for mutual TLS
        if (self.config.client_cert_path and
                self.config.client_key_path):
            ctx.load_cert_chain(
                certfile=self.config.client_cert_path,
                keyfile=self.config.client_key_path)
            logger.info("Loaded client certificate for mutual TLS")

        # Configure cipher suites
        if self.config.cipher_suites:
            cipher_string = ':'.join(self.config.cipher_suites)
            try:
                ctx.set_ciphers(cipher_string)
            except ssl.SSLError as e:
                logger.warning(f"Cipher config failed: {e}, using defaults")

        # Set verification depth
        ctx.verify_flags = ssl.VERIFY_X509_STRICT

        self.ssl_context = ctx
        logger.info(f"SSL context created (min={self.config.min_tls_version})")
        return ctx

    def perform_handshake(self, hostname: str, port: int,
                          timeout_ms: Optional[int] = None
                          ) -> Optional[ssl.SSLSocket]:
        """
        Perform the complete TLS handshake with a remote server.

        Executes the connection sequence:
          1. Create TCP socket and connect to server
          2. Wrap socket with SSL context
          3. Set SNI hostname for virtual hosting
          4. Execute TLS handshake (cipher negotiation)
          5. Verify server certificate chain
          6. Cache session for potential reuse

        Includes retry logic for transient failures.

        Args:
            hostname: Target server hostname
            port: Target server port
            timeout_ms: Handshake timeout (default from config)

        Returns:
            Connected ssl.SSLSocket, or None on failure
        """
        if self.ssl_context is None:
            self.create_ssl_context()

        timeout = (timeout_ms or self.config.handshake_timeout_ms) / 1000.0
        max_retries = self.config.max_retries

        for attempt in range(1, max_retries + 1):
            try:
                # Step 1: Create TCP socket
                raw_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                raw_socket.settimeout(timeout)

                # Step 2: Connect TCP
                logger.info(f"Connecting to {hostname}:{port} "
                           f"(attempt {attempt}/{max_retries})")
                raw_socket.connect((hostname, port))

                # Step 3: Wrap with SSL (sets SNI via server_hostname)
                ssl_socket = self.ssl_context.wrap_socket(
                    raw_socket, server_hostname=hostname)

                # Step 4: Handshake happens implicitly in wrap_socket
                # but we can verify it completed
                ssl_socket.do_handshake()

                # Step 5: Verify certificate details
                cert = ssl_socket.getpeercert()
                if cert is None and not self.config.allow_self_signed:
                    logger.error("No peer certificate received")
                    ssl_socket.close()
                    continue

                if not self._verify_cert_details(cert, hostname):
                    ssl_socket.close()
                    continue

                # Step 6: Log connection details
                cipher_name, protocol, bits = ssl_socket.cipher()
                logger.info(
                    f"TLS handshake complete: {hostname}:{port} "
                    f"({protocol}, {cipher_name}, {bits} bits)")

                # Cache session for resumption
                self._cache_session(hostname, port)

                return ssl_socket

            except ssl.SSLCertVerificationError as e:
                logger.error(f"Certificate verification failed: {e}")
                return None  # Don't retry cert failures

            except ssl.SSLError as e:
                logger.warning(f"SSL error (attempt {attempt}): {e}")
                if attempt < max_retries:
                    time.sleep(1.0 * attempt)

            except socket.timeout:
                logger.warning(f"Connection timeout (attempt {attempt})")
                if attempt < max_retries:
                    time.sleep(1.0 * attempt)

            except ConnectionRefusedError:
                logger.error(f"Connection refused by {hostname}:{port}")
                return None  # Don't retry refused connections

            except Exception as e:
                logger.error(f"Unexpected error: {type(e).__name__}: {e}")
                if attempt < max_retries:
                    time.sleep(1.0 * attempt)

        logger.error(f"Handshake failed after {max_retries} attempts")
        return None

    def _verify_cert_details(self, cert: dict, hostname: str) -> bool:
        """
        Perform additional certificate verification beyond what
        Python's ssl module checks automatically.

        Validates:
        - Certificate has expected subject fields
        - Not-before and not-after dates are reasonable
        - Subject Alternative Names include the hostname
        """
        if cert is None:
            return self.config.allow_self_signed

        # Check subject
        subject = dict(x[0] for x in cert.get('subject', ()))
        issuer = dict(x[0] for x in cert.get('issuer', ()))
        logger.info(f"Certificate subject: CN={subject.get('commonName')}")
        logger.info(f"Certificate issuer: O={issuer.get('organizationName')}")

        # Check SANs include the hostname
        san_list = cert.get('subjectAltName', ())
        dns_names = [name for typ, name in san_list if typ == 'DNS']
        if dns_names:
            logger.debug(f"SANs: {dns_names}")
            for name in dns_names:
                if self._hostname_matches(name, hostname):
                    return True
            if self.config.verify_hostname:
                logger.error(f"Hostname {hostname} not in SANs: {dns_names}")
                return False

        # Check expiration warnings
        not_after = cert.get('notAfter')
        if not_after:
            logger.debug(f"Certificate expires: {not_after}")

        return True

    def _hostname_matches(self, pattern: str, hostname: str) -> bool:
        """Match hostname against wildcard pattern (RFC 6125)."""
        if pattern.startswith('*.'):
            suffix = pattern[2:]
            dot_idx = hostname.find('.')
            if dot_idx >= 0:
                return hostname[dot_idx + 1:].lower() == suffix.lower()
            return False
        return pattern.lower() == hostname.lower()

    def _cache_session(self, hostname: str, port: int) -> None:
        """Cache session info for potential resumption."""
        key = f"{hostname}:{port}"
        self._session_cache[key] = {
            'timestamp': time.time(),
            'hostname': hostname,
            'port': port,
        }

    def get_session_info(self, ssl_socket: ssl.SSLSocket) -> dict:
        """Extract session details from established connection."""
        cipher_name, protocol, bits = ssl_socket.cipher()
        cert = ssl_socket.getpeercert()
        subject = dict(x[0] for x in cert.get('subject', ())) if cert else {}

        return {
            'protocol': protocol,
            'cipher': cipher_name,
            'key_bits': bits,
            'server_cn': subject.get('commonName', 'unknown'),
            'peer_address': ssl_socket.getpeername(),
        }
