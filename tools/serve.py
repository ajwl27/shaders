#!/usr/bin/env python3
"""
Static dev server for the gallery.

`python -m http.server` looks up MIME types in the Windows registry, where .js
is commonly registered as text/plain. Browsers refuse to execute ES modules
served with a non-JavaScript MIME type, so the whole module graph silently
fails to load. This forces the correct types and disables caching.

    python tools/serve.py [port]
"""

import functools
import http.server
import os
import sys

TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".html": "text/html",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".glsl": "text/plain",
    ".wasm": "application/wasm",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in TYPES:
            return TYPES[ext]
        return super().guess_type(path)

    def end_headers(self):
        # Shaders are edited constantly; a cached module is a wasted debugging hour.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        if "404" in (fmt % args):
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    handler = functools.partial(Handler, directory=root)
    server = http.server.ThreadingHTTPServer(("", port), handler)
    print(f"serving {root} at http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
