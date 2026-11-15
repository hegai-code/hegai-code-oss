#!/usr/bin/env python3
"""Render the web app's home-screen icons. `npm run icons --workspace web`

The installed web app (PWA: "Add to Home Screen" on iOS, "Install" on Android)
wears the SAME face as the native iOS app — ivory a.test with the ember dot and
a bold "code" on navy, laid out by `ios/scripts/render-app-icon.py` — plus an
ember "WEB" plate underneath. The plate is the whole point: on a phone that has
both the App Store app and the PWA, two identical icons named "Hegai" meant
nobody could tell which was which (Owner, 11.10.2026).

Writes PNG only. iOS ignores an SVG `apple-touch-icon` and falls back to a
screenshot of the page, and Chrome prefers an SVG manifest icon over the PNGs
when one is listed — so there is no SVG app icon any more. The browser-tab
favicon (`favicon.svg`, the flash mark) is a different thing and stays.

The same files go to both bundles: `web/public` (code.acme.test) and
`web/lite/public` (remote.acme.test). Requires Pillow.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WEB = Path(__file__).resolve().parents[1]
IOS = WEB.parent / "ios"
OUT_DIRS = [WEB / "public", WEB / "lite/public"]

NAVY = "#0B1730"  # = the iOS icon ground
IVORY = "#F4F1E8"  # = the iOS "code"
EMBER = "#FF6A3D"  # = the dot in hegai-wordmark.png
FONT = str(IOS / "CCRemote/Resources/Fonts/Onest-Bold.ttf")
S = 1024  # master canvas; every size is a downscale of it


def lockup() -> Image.Image:
    """a.test over "code" over the WEB plate, cropped to its visible ink."""
    art = Image.new("RGBA", (S, S))
    art.alpha_composite(Image.open(IOS / "artwork/hegai-wordmark.png").convert("RGBA"))
    ImageDraw.Draw(art).text((512, 842), "code", font=ImageFont.truetype(FONT, 270), fill=IVORY, anchor="ms")
    art = art.crop(art.getbbox())

    # Ink on ember, never ivory: ivory on ember is 2.7:1 (DESIGN.md «Цвет»).
    h = 165
    font = ImageFont.truetype(FONT, round(h * 0.62))
    w = round(font.getlength("WEB") + h * 0.9)
    plate = Image.new("RGBA", (w, h))
    d = ImageDraw.Draw(plate)
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 2, fill=EMBER)
    d.text((w / 2, h / 2), "WEB", font=font, fill=NAVY, anchor="mm")

    gap = 55
    out = Image.new("RGBA", (art.width, art.height + gap + h))
    out.alpha_composite(art, (0, 0))
    out.alpha_composite(plate, ((art.width - w) // 2, art.height + gap))
    return out


def icon(width: int) -> Image.Image:
    """Navy square with the lockup `width` px wide, centred."""
    art = lockup()
    k = width / art.width
    art = art.resize((round(art.width * k), round(art.height * k)), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (S, S), NAVY)
    canvas.alpha_composite(art, ((S - art.width) // 2, (S - art.height) // 2))
    return canvas.convert("RGB")


# - `any` (iOS 180, manifest 192/512): the lockup at 660/1024, close to the
#   native icon's proportions, so iOS's rounded mask never touches the letters.
# - `maskable` (Android adaptive): the launcher may crop to a circle of radius
#   0.4·size, so the whole lockup must sit inside it — 520/1024 does.
plain = icon(660)
maskable = icon(520)
JOBS = [(plain, "icon-180.png", 180), (plain, "icon-192.png", 192), (plain, "icon-512.png", 512), (maskable, "icon-maskable-512.png", 512)]

for out_dir in OUT_DIRS:
    for img, name, size in JOBS:
        img.resize((size, size), Image.Resampling.LANCZOS).save(out_dir / name, optimize=True)
        print(f"✓ {out_dir.relative_to(WEB)}/{name}  {size}×{size}")
