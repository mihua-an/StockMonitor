"""Draw the app icon (two candlesticks, up and down, on the app's dark ground) as PNG files.

    python scripts/tooling/make_app_icon.py

packaging/icon.png (256 px) is the installer / exe icon electron-builder picks up from buildResources; ui/main/assets/
tray.png (32 px) is the system-tray icon. Pure standard library (zlib), so the icon is reproducible from the repo.
Colors: the one red and green of the app (styles/tokens.css --market-red / --market-green).
"""
from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GROUND = (27, 35, 48, 255)
RED = (225, 25, 25, 255)
GREEN = (0, 153, 61, 255)
CLEAR = (0, 0, 0, 0)


def _png(size: int, pixels: list[list[tuple[int, int, int, int]]]) -> bytes:
    raw = b"".join(b"\x00" + b"".join(bytes(p) for p in row) for row in pixels)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def draw(size: int) -> bytes:
    s = size / 32.0
    pixels = [[CLEAR] * size for _ in range(size)]

    def rect(x0: float, y0: float, x1: float, y1: float, color) -> None:
        for y in range(max(0, round(y0 * s)), min(size, round(y1 * s))):
            for x in range(max(0, round(x0 * s)), min(size, round(x1 * s))):
                pixels[y][x] = color

    # Rounded ground: a square with its corners cut by a radius of 6 (of 32).
    radius = 6 * s
    for y in range(size):
        for x in range(size):
            cx = min(max(x + 0.5, radius), size - radius)
            cy = min(max(y + 0.5, radius), size - radius)
            if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius ** 2:
                pixels[y][x] = GROUND
    # Up candle (green): wick 6..26, body 10..22. Down candle (red): wick 8..28, body 14..24.
    rect(11.5, 5, 13.5, 25, GREEN)
    rect(8, 10, 17, 21, GREEN)
    rect(19.5, 8, 21.5, 28, RED)
    rect(16, 14, 25, 24, RED)
    return _png(size, pixels)


def main() -> int:
    targets = {ROOT / "packaging" / "icon.png": 256, ROOT / "ui" / "main" / "assets" / "tray.png": 32}
    for path, size in targets.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(draw(size))
        print(f"{path.relative_to(ROOT)}: {size}x{size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
