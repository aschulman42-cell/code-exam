"""
session_manager.py - Secure Session Lifecycle Management

Manages the lifecycle of secure TLS sessions: creation, reuse,
health monitoring, and cleanup. Provides the primary API for
application code to establish and manage encrypted connections.

This is the main entry point for the Python networking subsystem.

Copyright (c) 2024 SecureNet Systems, Inc.
"""

import logging
import time
import threading
from typing import Optional, Dict, List
from dataclasses import dataclass, field
from config_parser import TLSConfig, load_tls_config
from handshake import TLSHandshake

logger = logging.getLogger(__name__)

SESSION_IDLE_TIMEOUT = 300.0    # 5 minutes
HEALTH_CHECK_INTERVAL = 60.0   # 1 minute
MAX_SESSION_AGE = 3600.0        # 1 hour


@dataclass
class SessionInfo:
    """Metadata for an active TLS session."""
    hostname: str
    port: int
    ssl_socket: object  # ssl.SSLSocket
    created: float = field(default_factory=time.time)
    last_used: float = field(default_factory=time.time)
    bytes_sent: int = 0
    bytes_recv: int = 0
    use_count: int = 0
    protocol: str = ""
    cipher: str = ""


class SessionManager:
    """
    Manages a collection of secure TLS sessions with automatic
    lifecycle handling. Provides connection reuse, health checking,
    and graceful shutdown.
    """

    def __init__(self, config_path: Optional[str] = None,
                 config: Optional[TLSConfig] = None):
        """
        Initialize the session manager.

        Args:
            config_path: Path to TLS config JSON file
            config: Pre-loaded TLSConfig (overrides config_path)
        """
        if config is not None:
            self.config = config
        elif config_path is not None:
            self.config = load_tls_config(config_path)
        else:
            self.config = TLSConfig()  # defaults

        self.handshake = TLSHandshake(self.config)
        self._sessions: Dict[str, SessionInfo] = {}
        self._lock = threading.Lock()
        self._shutdown = False

        # Start background health checker
        self._health_thread = threading.Thread(
            target=self._health_check_loop, daemon=True)
        self._health_thread.start()

        logger.info("SessionManager initialized")

    def connect(self, hostname: str, port: int = 443) -> Optional[object]:
        """
        Establish or reuse a secure connection to the target host.

        First checks for an existing healthy session. If none
        exists, performs a new TLS handshake. Returns the SSL
        socket for data transmission.

        This is the primary entry point for creating encrypted
        communication channels.

        Args:
            hostname: Target server hostname
            port: Target server port (default 443)

        Returns:
            Connected ssl.SSLSocket, or None on failure
        """
        if self._shutdown:
            logger.warning("SessionManager is shutting down")
            return None

        key = f"{hostname}:{port}"

        # Check for reusable session
        with self._lock:
            session = self._sessions.get(key)
            if session is not None:
                if self._is_session_healthy(session):
                    session.last_used = time.time()
                    session.use_count += 1
                    logger.info(f"Reusing session to {key} "
                               f"(use #{session.use_count})")
                    return session.ssl_socket
                else:
                    # Stale session, remove it
                    self._close_session(session)
                    del self._sessions[key]

        # Establish new connection
        logger.info(f"Establishing new secure connection to {key}")
        ssl_socket = self.handshake.perform_handshake(hostname, port)

        if ssl_socket is None:
            logger.error(f"Failed to establish connection to {key}")
            return None

        # Register session
        info = self.handshake.get_session_info(ssl_socket)
        session = SessionInfo(
            hostname=hostname,
            port=port,
            ssl_socket=ssl_socket,
            protocol=info.get('protocol', ''),
            cipher=info.get('cipher', ''),
            use_count=1,
        )

        with self._lock:
            self._sessions[key] = session

        logger.info(f"New session established: {key} "
                   f"({session.protocol}, {session.cipher})")
        return ssl_socket

    def send(self, hostname: str, port: int, data: bytes) -> int:
        """
        Send data over a secure session.

        Automatically establishes a connection if none exists.
        Handles connection failures with automatic retry.

        Returns:
            Number of bytes sent, or -1 on error
        """
        ssl_socket = self.connect(hostname, port)
        if ssl_socket is None:
            return -1

        key = f"{hostname}:{port}"
        try:
            ssl_socket.sendall(data)
            with self._lock:
                session = self._sessions.get(key)
                if session:
                    session.bytes_sent += len(data)
                    session.last_used = time.time()
            return len(data)

        except Exception as e:
            logger.error(f"Send failed to {key}: {e}")
            # Invalidate session
            with self._lock:
                session = self._sessions.pop(key, None)
                if session:
                    self._close_session(session)
            return -1

    def recv(self, hostname: str, port: int,
             buf_size: int = 8192) -> Optional[bytes]:
        """
        Receive data from a secure session.

        Returns:
            Received bytes, or None on error/close
        """
        key = f"{hostname}:{port}"

        with self._lock:
            session = self._sessions.get(key)
            if session is None:
                logger.error(f"No active session for {key}")
                return None
            ssl_socket = session.ssl_socket

        try:
            data = ssl_socket.recv(buf_size)
            if data:
                with self._lock:
                    session = self._sessions.get(key)
                    if session:
                        session.bytes_recv += len(data)
                        session.last_used = time.time()
            return data if data else None

        except Exception as e:
            logger.error(f"Recv failed from {key}: {e}")
            return None

    def disconnect(self, hostname: str, port: int) -> None:
        """Close a specific session."""
        key = f"{hostname}:{port}"
        with self._lock:
            session = self._sessions.pop(key, None)
            if session:
                self._close_session(session)
                logger.info(f"Disconnected from {key}")

    def get_stats(self) -> List[Dict]:
        """Get statistics for all active sessions."""
        stats = []
        with self._lock:
            for key, session in self._sessions.items():
                age = time.time() - session.created
                idle = time.time() - session.last_used
                stats.append({
                    'endpoint': key,
                    'protocol': session.protocol,
                    'cipher': session.cipher,
                    'age_seconds': round(age, 1),
                    'idle_seconds': round(idle, 1),
                    'bytes_sent': session.bytes_sent,
                    'bytes_recv': session.bytes_recv,
                    'use_count': session.use_count,
                })
        return stats

    def shutdown(self) -> None:
        """Gracefully shut down all sessions."""
        self._shutdown = True
        with self._lock:
            for key, session in self._sessions.items():
                self._close_session(session)
                logger.info(f"Closed session: {key}")
            self._sessions.clear()
        logger.info("SessionManager shutdown complete")

    def _is_session_healthy(self, session: SessionInfo) -> bool:
        """Check if a session is still usable."""
        now = time.time()

        # Check age
        if now - session.created > MAX_SESSION_AGE:
            logger.info(f"Session to {session.hostname} expired (age)")
            return False

        # Check idle timeout
        if now - session.last_used > SESSION_IDLE_TIMEOUT:
            logger.info(f"Session to {session.hostname} expired (idle)")
            return False

        # Check socket is still open
        try:
            sock = session.ssl_socket
            if hasattr(sock, 'fileno') and sock.fileno() < 0:
                return False
        except Exception:
            return False

        return True

    def _close_session(self, session: SessionInfo) -> None:
        """Close a session safely."""
        try:
            if session.ssl_socket is not None:
                session.ssl_socket.close()
        except Exception:
            pass

    def _health_check_loop(self) -> None:
        """Background thread: periodically check session health."""
        while not self._shutdown:
            time.sleep(HEALTH_CHECK_INTERVAL)
            expired = []
            with self._lock:
                for key, session in self._sessions.items():
                    if not self._is_session_healthy(session):
                        expired.append(key)
                for key in expired:
                    session = self._sessions.pop(key)
                    self._close_session(session)
                    logger.info(f"Health check: closed expired session {key}")


def main():
    """Command-line entry point for testing connections."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Test TLS connections")
    parser.add_argument("hostname",
        help="Server hostname to connect to")
    parser.add_argument("--port", type=int, default=443,
        help="Server port (default: 443)")
    parser.add_argument("--config", default=None,
        help="Path to TLS config file")
    parser.add_argument("--verbose", action="store_true",
        help="Enable debug logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    mgr = SessionManager(config_path=args.config)

    try:
        sock = mgr.connect(args.hostname, args.port)
        if sock:
            print(f"Connected to {args.hostname}:{args.port}")
            stats = mgr.get_stats()
            for s in stats:
                print(f"  Protocol: {s['protocol']}")
                print(f"  Cipher:   {s['cipher']}")
        else:
            print(f"Failed to connect to {args.hostname}:{args.port}")
    finally:
        mgr.shutdown()


if __name__ == '__main__':
    main()
