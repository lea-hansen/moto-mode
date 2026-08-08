#!/usr/bin/env python3
"""Erzeugt die PWA-Icons ohne externe Abhaengigkeiten (reiner PNG-Encoder).

    python3 tools/make_icons.py

Motiv: schwarzes Feld, blauer Tacho-Bogen, weisser Zeiger — passend zum UI.
"""

import math
import os
import struct
import zlib

BG = (0, 0, 0)
TRACK = (58, 58, 60)
BLUE = (10, 132, 255)
WHITE = (255, 255, 255)

SS = 3  # Supersampling


def write_png(path, width, height, rows):
    raw = b"".join(b"\x00" + bytes(v for px in row for v in px) for row in rows)

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", header)
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(png)


def sample(x, y, cx, cy, r_out, r_in, needle_t, needle_len):
    """Farbe eines Punktes in Pixelkoordinaten, oder None fuer Hintergrund."""
    dx, dy = x - cx, cy - y
    r = math.hypot(dx, dy)

    # Nabe
    if r < r_out * 0.13:
        return WHITE

    # Zeiger
    ang = math.radians(225 - needle_t * 270)
    nx, ny = math.cos(ang), math.sin(ang)
    along = dx * nx + dy * ny
    across = abs(-dx * ny + dy * nx)
    if 0 <= along <= needle_len and across < r_out * 0.055 * (1 - 0.55 * along / needle_len):
        return WHITE

    # Bogen
    if r_in <= r <= r_out:
        a = math.degrees(math.atan2(dy, dx)) % 360
        if a <= 225:
            t = (225 - a) / 270
        elif a >= 315:
            t = (585 - a) / 270
        else:
            return None
        return BLUE if t <= needle_t else TRACK

    return None


def render(size, inset=0.0):
    """inset > 0 schrumpft das Motiv (fuer maskable Icons mit Safe Zone)."""
    scale = 1.0 - inset
    cx = cy = size / 2
    r_out = size * 0.40 * scale
    r_in = r_out * 0.80
    needle_t = 0.62
    needle_len = r_in * 0.92

    rows = []
    for py in range(size):
        row = []
        for px in range(size):
            acc = [0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    c = sample(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS,
                               cx, cy, r_out, r_in, needle_t, needle_len) or BG
                    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]
            n = SS * SS
            row.append((round(acc[0] / n), round(acc[1] / n), round(acc[2] / n), 255))
        rows.append(row)
    return rows


def main():
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
    os.makedirs(out, exist_ok=True)
    for name, size, inset in [
        ("icon-192.png", 192, 0.0),
        ("icon-512.png", 512, 0.0),
        ("apple-touch-icon-180.png", 180, 0.0),
        ("icon-maskable-512.png", 512, 0.22),
    ]:
        write_png(os.path.join(out, name), size, size, render(size, inset))
        print("geschrieben:", name)


if __name__ == "__main__":
    main()
