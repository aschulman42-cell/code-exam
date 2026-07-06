# Demo Source Tree: SecureNet TLS Connection Library

This is a **synthetic sample codebase** designed to demonstrate the
Air-Gapped Source Code Analysis Tool. It implements a multi-language
TLS/SSL connection management system across C, Java, and Python.

## Purpose

This codebase is designed so that key tool commands produce interesting,
demonstrable output:

- **--hotspots**: `tls_connect`, `establishConnection`, `perform_handshake`
  surface as the most important functions (large + heavily called).

- **--domain-fns**: Domain-specific names like `verify_certificate_chain`,
  `negotiate_cipher_params` rank above generic utilities like `log_error`.

- **--entry-points**: `main()` in session_manager.py, `tls_connect` (if
  not called within this codebase), `establishConnection`.

- **--hot-folders**: `c/` and `java/net/` show as the primary architecture;
  `c/utils/` ranks lower as infrastructure.

- **--multisect-search**: Patent claim elements (cryptographic context,
  cipher negotiation, certificate verification, encrypted channel) can be
  found at function, file, and folder scope levels.

- **--struct-dupes**: The certificate validation logic in `cert_verify.c`
  and `CertificateValidator.java` follows the same algorithm structure
  (chain walk → hostname check → expiration → key usage), demonstrating
  cross-language structural duplication.

- **--callers/--callees**: `tls_connect` calls `initialize_crypto_context`,
  `negotiate_cipher_params`, `verify_certificate_chain`, showing the
  connection establishment call graph.

## File Inventory

### C (core implementation layer)
| File | Functions | Role |
|------|-----------|------|
| `c/tls_handler.c` | 7 | **Star file**: tls_connect, SSL_CTX_new, cipher negotiation, send/recv |
| `c/tls_handler.h` | 0 (declarations) | Public API declarations, struct definitions |
| `c/cert_verify.c` | 5 | Certificate chain verification, hostname matching |
| `c/crypto_context.c` | 5 | SSL context lifecycle, session caching |
| `c/utils/buffer_pool.c` | 5 | Buffer memory management (utility) |
| `c/utils/logging.c` | 6 | Logging infrastructure (utility, small functions) |

### Java (application layer)
| File | Methods | Role |
|------|---------|------|
| `java/net/NetworkManager.java` | 8 | **Orchestrator**: high fan-out, calls everything |
| `java/net/CertificateValidator.java` | 7 | Cert verification (structural dupe of cert_verify.c) |
| `java/net/CipherNegotiator.java` | 4 | Cipher suite selection |
| `java/net/SecureChannel.java` | 4 | Encrypted data framing and transmission |
| `java/net/ConnectionPool.java` | 5 | Connection reuse management |
| `java/net/ConnectionConfig.java` | 11 | Config data class (getters/setters) |

### Python (scripting/testing layer)
| File | Functions | Role |
|------|-----------|------|
| `python/config_parser.py` | 6 | TLS config loading and validation |
| `python/handshake.py` | 7 | TLS handshake protocol implementation |
| `python/session_manager.py` | 11 | Session lifecycle management, entry point |
| `python/test_tls.py` | 9 | Unit tests (exclude with --exclude-path test) |

## Sample Patent Claim

`sample_patent_claim.txt` contains a synthetic patent claim about
"establishing a secure communication connection" with elements that
map to specific code locations:

| Claim Element | Code Location |
|---------------|---------------|
| "initializing a cryptographic context" | `tls_handler.c::initialize_crypto_context()` |
| "negotiating cipher parameters" | `tls_handler.c::negotiate_cipher_params()`, `CipherNegotiator.java` |
| "performing a handshake protocol" | `handshake.py::TLSHandshake.perform_handshake()` |
| "verifying a certificate chain" | `cert_verify.c::verify_certificate_chain()`, `CertificateValidator.java` |
| "transmitting over encrypted channel" | `tls_handler.c::tls_send_encrypted()`, `SecureChannel.java` |
