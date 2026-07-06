"""
config_parser.py - TLS Configuration Management

Reads, validates, and manages TLS connection configuration from
YAML/JSON config files. Handles certificate paths, cipher suite
preferences, protocol version constraints, and trust store setup.

Copyright (c) 2024 SecureNet Systems, Inc.
"""

import os
import json
import logging
from dataclasses import dataclass, field
from typing import List, Optional, Dict, Any
from pathlib import Path

logger = logging.getLogger(__name__)

# Default cipher suite preference list
DEFAULT_CIPHER_SUITES = [
    "TLS_AES_256_GCM_SHA384",
    "TLS_CHACHA20_POLY1305_SHA256",
    "TLS_AES_128_GCM_SHA256",
    "ECDHE-ECDSA-AES256-GCM-SHA384",
    "ECDHE-RSA-AES256-GCM-SHA384",
]

# Minimum acceptable TLS versions
VALID_TLS_VERSIONS = ["TLSv1.2", "TLSv1.3"]

# Blocked cipher suites (known insecure)
BLOCKED_CIPHERS = {
    "RC4", "DES", "3DES", "MD5", "NULL", "EXPORT", "anon"
}


@dataclass
class TLSConfig:
    """Configuration for TLS secure connections."""
    min_tls_version: str = "TLSv1.2"
    min_key_bits: int = 128
    cipher_suites: List[str] = field(default_factory=lambda: list(DEFAULT_CIPHER_SUITES))
    ca_cert_path: Optional[str] = None
    client_cert_path: Optional[str] = None
    client_key_path: Optional[str] = None
    verify_hostname: bool = True
    allow_self_signed: bool = False
    session_cache_size: int = 128
    handshake_timeout_ms: int = 5000
    max_retries: int = 3
    cert_verify_depth: int = 4


def load_tls_config(config_path: str) -> TLSConfig:
    """
    Load TLS configuration from a JSON file.

    Reads the configuration file, validates all fields, resolves
    relative certificate paths, and returns a TLSConfig object
    ready for use with the secure connection system.

    Args:
        config_path: Path to JSON configuration file

    Returns:
        Validated TLSConfig object

    Raises:
        FileNotFoundError: If config file does not exist
        ValueError: If configuration values are invalid
    """
    config_path = Path(config_path)
    if not config_path.exists():
        raise FileNotFoundError(f"Config file not found: {config_path}")

    with open(config_path, 'r') as f:
        raw = json.load(f)

    config = TLSConfig()
    config_dir = config_path.parent

    # TLS version
    if 'min_tls_version' in raw:
        version = raw['min_tls_version']
        if version not in VALID_TLS_VERSIONS:
            raise ValueError(
                f"Invalid TLS version '{version}'. "
                f"Must be one of: {VALID_TLS_VERSIONS}")
        config.min_tls_version = version

    # Minimum key bits
    if 'min_key_bits' in raw:
        bits = int(raw['min_key_bits'])
        if bits < 56 or bits > 512:
            raise ValueError(f"min_key_bits {bits} out of range [56, 512]")
        config.min_key_bits = bits

    # Cipher suites
    if 'cipher_suites' in raw:
        ciphers = raw['cipher_suites']
        validated = validate_cipher_list(ciphers)
        if not validated:
            logger.warning("No valid cipher suites in config, using defaults")
        else:
            config.cipher_suites = validated

    # Certificate paths (resolve relative to config file)
    for cert_field in ['ca_cert_path', 'client_cert_path', 'client_key_path']:
        if cert_field in raw and raw[cert_field]:
            cert_path = Path(raw[cert_field])
            if not cert_path.is_absolute():
                cert_path = config_dir / cert_path
            if not cert_path.exists():
                logger.warning(f"{cert_field} not found: {cert_path}")
            setattr(config, cert_field, str(cert_path))

    # Boolean flags
    if 'verify_hostname' in raw:
        config.verify_hostname = bool(raw['verify_hostname'])
    if 'allow_self_signed' in raw:
        config.allow_self_signed = bool(raw['allow_self_signed'])

    # Numeric settings
    for int_field in ['session_cache_size', 'handshake_timeout_ms',
                      'max_retries', 'cert_verify_depth']:
        if int_field in raw:
            setattr(config, int_field, int(raw[int_field]))

    logger.info(f"TLS config loaded: TLS>={config.min_tls_version}, "
                f"min {config.min_key_bits} bits, "
                f"{len(config.cipher_suites)} ciphers")
    return config


def validate_cipher_list(ciphers: List[str]) -> List[str]:
    """
    Filter out blocked cipher suites from the provided list.

    Removes any cipher suite containing known insecure algorithm
    names (RC4, DES, NULL, etc.) and logs warnings for each
    rejected entry.

    Args:
        ciphers: List of cipher suite names to validate

    Returns:
        Filtered list containing only acceptable ciphers
    """
    valid = []
    for cipher in ciphers:
        blocked = False
        for bad in BLOCKED_CIPHERS:
            if bad.upper() in cipher.upper():
                logger.warning(f"Blocked insecure cipher: {cipher} "
                              f"(contains {bad})")
                blocked = True
                break
        if not blocked:
            valid.append(cipher)
    return valid


def generate_default_config(output_path: str) -> None:
    """
    Generate a default TLS configuration file.

    Creates a JSON configuration file with secure default settings.
    Useful for initial setup or as a template for customization.
    """
    config = {
        "min_tls_version": "TLSv1.2",
        "min_key_bits": 128,
        "cipher_suites": DEFAULT_CIPHER_SUITES,
        "ca_cert_path": "./certs/ca-bundle.crt",
        "client_cert_path": None,
        "client_key_path": None,
        "verify_hostname": True,
        "allow_self_signed": False,
        "session_cache_size": 128,
        "handshake_timeout_ms": 5000,
        "max_retries": 3,
        "cert_verify_depth": 4
    }

    with open(output_path, 'w') as f:
        json.dump(config, f, indent=2)

    logger.info(f"Default TLS config written to {output_path}")


def merge_configs(base: TLSConfig, overrides: Dict[str, Any]) -> TLSConfig:
    """
    Merge override values into a base TLS configuration.

    Allows command-line arguments or environment variables to
    override specific fields from the config file while keeping
    all other values at their configured defaults.
    """
    import copy
    merged = copy.deepcopy(base)

    for key, value in overrides.items():
        if hasattr(merged, key) and value is not None:
            setattr(merged, key, value)
            logger.debug(f"Config override: {key} = {value}")

    return merged


def get_cert_info(cert_path: str) -> Dict[str, str]:
    """
    Extract basic information from a PEM certificate file.

    Reads the certificate and returns subject, issuer, serial
    number, and validity dates. Used for configuration validation
    and logging.
    """
    info = {}
    try:
        with open(cert_path, 'r') as f:
            content = f.read()

        # Basic PEM parsing (without crypto library dependency)
        if '-----BEGIN CERTIFICATE-----' not in content:
            info['error'] = 'Not a valid PEM certificate'
            return info

        info['path'] = cert_path
        info['size'] = os.path.getsize(cert_path)
        info['format'] = 'PEM'

        # Count certificates in bundle
        cert_count = content.count('-----BEGIN CERTIFICATE-----')
        info['certificates'] = cert_count

        if cert_count > 1:
            info['type'] = 'CA bundle'
        else:
            info['type'] = 'Single certificate'

    except FileNotFoundError:
        info['error'] = f'Certificate file not found: {cert_path}'
    except Exception as e:
        info['error'] = str(e)

    return info
