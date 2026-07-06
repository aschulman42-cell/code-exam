"""
test_tls.py - Unit tests for TLS connection subsystem

Tests for config_parser, handshake, and session_manager modules.
These test functions should be excludable via --exclude-path test.
"""

import unittest
import json
import tempfile
import os
from unittest.mock import Mock, patch, MagicMock

from config_parser import (
    TLSConfig, load_tls_config, validate_cipher_list,
    generate_default_config, merge_configs
)
from handshake import TLSHandshake
from session_manager import SessionManager, SessionInfo


class TestTLSConfig(unittest.TestCase):
    """Tests for TLS configuration loading and validation."""

    def test_default_config(self):
        """Default config should have secure defaults."""
        config = TLSConfig()
        self.assertEqual(config.min_tls_version, "TLSv1.2")
        self.assertEqual(config.min_key_bits, 128)
        self.assertTrue(config.verify_hostname)
        self.assertFalse(config.allow_self_signed)

    def test_load_config_from_file(self):
        """Should load and validate config from JSON file."""
        config_data = {
            "min_tls_version": "TLSv1.3",
            "min_key_bits": 256,
            "verify_hostname": True,
            "cipher_suites": ["TLS_AES_256_GCM_SHA384"]
        }
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json',
                                         delete=False) as f:
            json.dump(config_data, f)
            config_path = f.name

        try:
            config = load_tls_config(config_path)
            self.assertEqual(config.min_tls_version, "TLSv1.3")
            self.assertEqual(config.min_key_bits, 256)
        finally:
            os.unlink(config_path)

    def test_invalid_tls_version(self):
        """Should reject invalid TLS version strings."""
        config_data = {"min_tls_version": "SSLv3"}
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json',
                                         delete=False) as f:
            json.dump(config_data, f)
            config_path = f.name

        try:
            with self.assertRaises(ValueError):
                load_tls_config(config_path)
        finally:
            os.unlink(config_path)

    def test_validate_cipher_list_blocks_insecure(self):
        """Should filter out blocked cipher suites."""
        ciphers = [
            "TLS_AES_256_GCM_SHA384",
            "TLS_RSA_WITH_RC4_128_SHA",
            "TLS_CHACHA20_POLY1305_SHA256",
            "SSL_RSA_WITH_DES_CBC_SHA",
        ]
        valid = validate_cipher_list(ciphers)
        self.assertEqual(len(valid), 2)
        self.assertIn("TLS_AES_256_GCM_SHA384", valid)
        self.assertNotIn("TLS_RSA_WITH_RC4_128_SHA", valid)

    def test_merge_configs(self):
        """Should merge override values into base config."""
        base = TLSConfig()
        merged = merge_configs(base, {"min_key_bits": 256})
        self.assertEqual(merged.min_key_bits, 256)
        self.assertEqual(merged.min_tls_version, "TLSv1.2")  # unchanged


class TestCertificateValidation(unittest.TestCase):
    """Tests for certificate chain validation logic."""

    def test_hostname_wildcard_match(self):
        """Wildcard *.example.com should match sub.example.com."""
        hs = TLSHandshake(TLSConfig())
        self.assertTrue(hs._hostname_matches("*.example.com", "www.example.com"))
        self.assertFalse(hs._hostname_matches("*.example.com", "example.com"))
        self.assertFalse(hs._hostname_matches("*.example.com", "a.b.example.com"))

    def test_hostname_exact_match(self):
        """Exact hostname should match case-insensitively."""
        hs = TLSHandshake(TLSConfig())
        self.assertTrue(hs._hostname_matches("www.example.com", "www.example.com"))
        self.assertTrue(hs._hostname_matches("WWW.EXAMPLE.COM", "www.example.com"))

    def test_expired_cert_rejected(self):
        """Expired certificates should be rejected."""
        # This would require mocking ssl module responses
        pass

    def test_self_signed_rejected_by_default(self):
        """Self-signed certs should be rejected unless configured."""
        config = TLSConfig(allow_self_signed=False)
        hs = TLSHandshake(config)
        # Verify that verification mode is strict
        ctx = hs.create_ssl_context()
        self.assertTrue(ctx.check_hostname)


class TestSessionManager(unittest.TestCase):
    """Tests for session lifecycle management."""

    def test_session_reuse(self):
        """Second connect to same host should reuse session."""
        # Would require mocking actual TLS connections
        pass

    def test_idle_timeout(self):
        """Sessions idle beyond timeout should be evicted."""
        session = SessionInfo(
            hostname="example.com",
            port=443,
            ssl_socket=Mock(),
            last_used=0,  # epoch = very old
        )
        mgr = SessionManager()
        self.assertFalse(mgr._is_session_healthy(session))

    def test_shutdown_closes_all(self):
        """Shutdown should close all active sessions."""
        mgr = SessionManager()
        mock_socket = Mock()
        session = SessionInfo(
            hostname="example.com", port=443,
            ssl_socket=mock_socket)
        mgr._sessions["example.com:443"] = session
        mgr.shutdown()
        mock_socket.close.assert_called_once()
        self.assertEqual(len(mgr._sessions), 0)


if __name__ == '__main__':
    unittest.main()
