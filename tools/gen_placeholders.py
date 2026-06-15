#!/usr/bin/env python3
"""Generates placeholder PNG art for Star Baron. Run: python3 gen_placeholders.py

Re-runnable; overwrites. Replace any output PNG with real art of the SAME
filename + dimensions and the game picks it up automatically — no code change.
Requires `pip install pillow`.
"""
import os, random
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.abspath(__file__))   # adjust if not run from /tools
ASSETS = os.path.join(ROOT, "..", "assets")          # writes to ../assets
random.seed(7)


def font(size):
    for p in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def center(d, box, text, fnt, fill):
    x0, y0, x1, y1 = box
    tb = d.textbbox((0, 0), text, font=fnt)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    d.text(((x0 + x1 - tw) / 2 - tb[0], (y0 + y1 - th) / 2 - tb[1]), text, font=fnt, fill=fill)


def out(*parts):
    p = os.path.join(ASSETS, *parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    return p


PAL = [(123, 140, 255), (58, 214, 160), (255, 93, 115), (255, 194, 75), (255, 138, 61),
       (160, 120, 255), (80, 200, 255), (255, 120, 200), (120, 255, 170), (220, 220, 120),
       (255, 160, 140), (150, 170, 210)]


def portrait(i, color):
    S = 96
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=14, fill=tuple(int(c * 0.18) for c in color) + (255,))
    cx, cy, rx, ry = S // 2, S // 2 + 4, 26, 30
    d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=color + (255,))
    style = i % 4
    ec = (10, 12, 20, 255)
    if style == 0:
        for ox in (-10, 10):
            d.ellipse([cx + ox - 6, cy - 8, cx + ox + 6, cy + 6], fill=(255, 255, 255, 255))
            d.ellipse([cx + ox - 3, cy - 4, cx + ox + 3, cy + 4], fill=ec)
    elif style == 1:
        d.ellipse([cx - 10, cy - 10, cx + 10, cy + 10], fill=(255, 255, 255, 255))
        d.ellipse([cx - 5, cy - 5, cx + 5, cy + 5], fill=ec)
    elif style == 2:
        for ox in (-12, 0, 12):
            d.ellipse([cx + ox - 4, cy - 6, cx + ox + 4, cy + 6], fill=(255, 255, 255, 255))
            d.ellipse([cx + ox - 2, cy - 3, cx + ox + 2, cy + 3], fill=ec)
    else:
        for ox in (-11, 11):
            d.line([cx + ox - 6, cy - 2, cx + ox + 6, cy - 2], fill=ec, width=3)
    if i % 2 == 0:
        d.line([cx, cy - ry, cx, cy - ry - 12], fill=color + (255,), width=3)
        d.ellipse([cx - 4, cy - ry - 18, cx + 4, cy - ry - 10], fill=color + (255,))
    img.save(out("portraits", f"alien_{i:02d}.png"))


for i in range(12):
    portrait(i, PAL[i])

COMMS = {"iron_ore": ((150, 170, 210), "Fe"), "hydrogen": ((120, 200, 255), "H"), "helium3": ((180, 160, 255), "He3"),
         "water_ice": ((140, 220, 255), "H2O"), "foodstuffs": ((120, 210, 120), "FOOD"), "silicon": ((200, 200, 200), "Si"),
         "rare_earths": ((255, 200, 80), "REE"), "antimatter": ((255, 90, 160), "a-"), "spice": ((255, 140, 60), "SPC"),
         "synthsilk": ((230, 150, 255), "SILK"), "contraband": ((255, 70, 70), "???"), "nanochips": ((90, 220, 200), "CHIP")}
for k, (c, l) in COMMS.items():
    S = 64
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([2, 2, S - 3, S - 3], radius=10, fill=tuple(int(x * 0.22) for x in c) + (255,), outline=c + (255,), width=2)
    center(d, (0, 0, S, S), l, font(16), c + (255,))
    img.save(out("commodities", f"{k}.png"))

SHIPS = {"shuttle": ((150, 170, 210), "I"), "hauler": ((123, 140, 255), "II"), "freighter": ((58, 214, 160), "III"), "leviathan": ((255, 194, 75), "IV")}
for k, (c, t) in SHIPS.items():
    W, H = 96, 64
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.polygon([(8, H // 2), (W - 26, 12), (W - 10, H // 2), (W - 26, H - 12)], fill=tuple(int(x * 0.35) for x in c) + (255,), outline=c + (255,))
    d.ellipse([W - 30, H // 2 - 9, W - 12, H // 2 + 9], fill=c + (255,))
    d.polygon([(8, H // 2), (28, H // 2 - 16), (40, H // 2)], fill=c + (255,))
    d.polygon([(8, H // 2), (28, H // 2 + 16), (40, H // 2)], fill=c + (255,))
    center(d, (W - 30, H // 2 - 9, W - 12, H // 2 + 9), t, font(11), (10, 12, 20, 255))
    img.save(out("ships", f"{k}.png"))


def frame(name, base, label):
    W, H = 384, 216
    img = Image.new("RGBA", (W, H), base + (255,))
    d = ImageDraw.Draw(img)
    for y in range(0, H, 4):
        d.line([0, y, W, y], fill=(255, 255, 255, 8))
    d.rectangle([0, 0, W - 1, H - 1], outline=(255, 255, 255, 40), width=2)
    center(d, (0, 0, W, H), label, font(22), (255, 255, 255, 180))
    img.save(out("broadcast", f"{name}.png"))


frame("news", (20, 30, 55), "GBN NEWS")
frame("tv_drama", (45, 20, 45), "STARCROSSED")
frame("tv_ads", (20, 45, 40), "ADBREAK")
frame("tv_weather", (20, 40, 55), "VOID CAST")
frame("static", (18, 18, 24), "no signal")
print("placeholders generated")
