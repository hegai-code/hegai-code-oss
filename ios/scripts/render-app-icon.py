#!/usr/bin/env python3
"""Render the iOS app icon. Requires Pillow.

The web app's home-screen icon copies this layout and adds a WEB plate:
web/scripts/icons.py — change both together."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "CCRemote/Resources/Assets.xcassets"
icon = Image.new("RGB", (1024, 1024), "#0B1730")
mark = Image.open(ROOT / "artwork/hegai-wordmark.png").convert("RGBA")
artwork = Image.new("RGBA", (1024, 1024))
artwork.alpha_composite(mark)
font = ImageFont.truetype(str(ROOT / "CCRemote/Resources/Fonts/Onest-Bold.ttf"), 270)
draw = ImageDraw.Draw(artwork)
label = "code"
draw.text((512, 842), label, font=font, fill="#F4F1E8", anchor="ms")
# Center visible artwork, not the transparent source canvas or font baseline.
artwork = artwork.crop(artwork.getbbox())
artwork = artwork.resize((round(artwork.width * 0.94), round(artwork.height * 0.94)), Image.Resampling.LANCZOS)
icon.paste(artwork, ((1024 - artwork.width) // 2, (1024 - artwork.height) // 2), artwork)
icon.save(ASSETS / "AppIcon.appiconset/icon-1024.png")
