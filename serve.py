#!/usr/bin/env python3
"""Kleiner HTTPS-Dev-Server fuer den iPhone-Test.

    python3 serve.py            # https://<LAN-IP>:8443

Warum HTTPS? Geolocation, Service Worker und Wake Lock verlangen einen
"secure context". http://192.168.x.x reicht dafuer nicht — nur localhost oder
TLS. Das Zertifikat ist selbstsigniert, Safari fragt beim ersten Aufruf nach.
"""

import http.server
import os
import socket
import ssl
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(ROOT, ".certs")
CERT = os.path.join(CERT_DIR, "dev.crt")
KEY = os.path.join(CERT_DIR, "dev.key")
PORT = int(os.environ.get("PORT", "8443"))


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 80))   # TEST-NET, es fliessen keine Daten
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip):
    if os.path.exists(CERT) and os.path.exists(KEY):
        return
    os.makedirs(CERT_DIR, exist_ok=True)
    print("Erzeuge selbstsigniertes Zertifikat fuer", ip)
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", KEY, "-out", CERT, "-days", "825",
        "-subj", "/CN=Moto Mode Dev",
        "-addext", f"subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost",
    ], check=True)


class Handler(http.server.SimpleHTTPRequestHandler):
    """Kein Caching im Dev-Betrieb — sonst haelt der Browser alte Dateien fest."""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".webmanifest": "application/manifest+json",
        ".js": "text/javascript",
        ".mjs": "text/javascript",
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


def main():
    ip = lan_ip()
    ensure_cert(ip)

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(CERT, KEY)

    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    print(f"\n  Moto Mode laeuft auf  https://{ip}:{PORT}/")
    print("  Am iPhone oeffnen, Zertifikatswarnung bestaetigen,")
    print("  dann Teilen -> 'Zum Home-Bildschirm'.\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  Beendet.")


if __name__ == "__main__":
    main()
