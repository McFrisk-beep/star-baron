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

# =============================================================================
#  STAR MAP ART — stars, planets, race ships & stations, nebulae, asteroids.
#  Keep these filenames; swap any PNG for real art and the game picks it up.
# =============================================================================

def lighten(c, f):
    return tuple(min(255, int(x + (255 - x) * f)) for x in c[:3])

def darken(c, f):
    return tuple(int(x * (1 - f)) for x in c[:3])

def sphere(d, cx, cy, r, color, hi=0.45, sh=0.5):
    """A cheap shaded ball: base + top-left highlight + bottom-right terminator."""
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color + (255,))
    d.ellipse([cx - r * 0.55, cy - r * 0.55, cx + r * 0.15, cy + r * 0.15],
              fill=lighten(color, hi) + (160,))
    d.ellipse([cx - r * 0.15, cy - r * 0.15, cx + r, cy + r],
              fill=darken(color, sh) + (90,))

# ---- STARS (galaxy-map nodes) ----------------------------------------------
STARS = {"yellow": (255, 221, 120), "blue": (150, 200, 255), "red": (255, 120, 110),
         "white": (235, 240, 255), "orange": (255, 170, 90), "neutron": (200, 230, 255),
         "binary": (255, 210, 150)}
for name, c in STARS.items():
    S = 48
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = S // 2
    for rr, a in [(22, 30), (16, 60), (11, 120)]:   # corona glow
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=c + (a,))
    if name == "binary":
        d.ellipse([cx - 10, cy - 6, cx - 2, cy + 2], fill=lighten(c, .4) + (255,))
        d.ellipse([cx + 1, cy - 1, cx + 9, cy + 7], fill=c + (255,))
    else:
        d.ellipse([cx - 8, cy - 8, cx + 8, cy + 8], fill=lighten(c, .35) + (255,))
        d.ellipse([cx - 4, cy - 4, cx + 4, cy + 4], fill=(255, 255, 255, 255))
    img.save(out("stars", f"{name}.png"))

# ---- PLANETS ---------------------------------------------------------------
PLANETS = {"rocky": (150, 130, 110), "terran": (70, 130, 200), "ocean": (60, 120, 210),
           "ice": (180, 220, 240), "lava": (70, 50, 50), "gas_giant": (210, 170, 120),
           "barren": (140, 140, 150), "ringed": (200, 180, 140), "toxic": (120, 180, 90)}
for name, c in PLANETS.items():
    S = 64
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    cx = cy = S // 2
    r = 24
    if name == "ringed":
        d.ellipse([cx - 31, cy - 9, cx + 31, cy + 9], outline=lighten(c, .3) + (200,), width=3)
    sphere(d, cx, cy, r, c)
    if name == "gas_giant" or name == "ringed":
        for i, yy in enumerate(range(cy - 16, cy + 17, 7)):
            band = lighten(c, .25) if i % 2 else darken(c, .2)
            d.line([cx - r, yy, cx + r, yy], fill=band + (120,), width=4)
    elif name == "terran":
        for _ in range(5):
            px, py = cx + random.randint(-15, 8), cy + random.randint(-14, 14)
            d.ellipse([px, py, px + random.randint(6, 12), py + random.randint(5, 9)],
                      fill=(70, 160, 90, 200))
    elif name in ("rocky", "barren"):
        for _ in range(6):
            px, py = cx + random.randint(-16, 12), cy + random.randint(-16, 12)
            d.ellipse([px, py, px + 5, py + 5], fill=darken(c, .35) + (180,))
    elif name == "lava":
        for _ in range(7):
            px, py = cx + random.randint(-16, 10), cy + random.randint(-16, 14)
            d.line([px, py, px + random.randint(4, 10), py + random.randint(-3, 3)],
                   fill=(255, 130, 40, 220), width=2)
    elif name == "ice":
        for _ in range(6):
            px, py = cx + random.randint(-15, 12), cy + random.randint(-15, 12)
            d.line([px, py, px + random.randint(3, 8), py + 2], fill=(255, 255, 255, 200), width=1)
    elif name in ("ocean", "toxic"):
        for _ in range(4):
            px, py = cx + random.randint(-14, 6), cy + random.randint(-12, 12)
            d.arc([px, py, px + 16, py + 10], 0, 180, fill=lighten(c, .35) + (160,), width=2)
    if name == "ringed":  # ring front half over the planet
        d.arc([cx - 31, cy - 9, cx + 31, cy + 9], 180, 360, fill=lighten(c, .4) + (220,), width=3)
    img.save(out("planets", f"{name}.png"))

# ---- RACES: ships + stations ----------------------------------------------
RACES = {"voidkin": (123, 140, 255), "glorthi": (58, 214, 160), "aurelian": (255, 194, 75),
         "krell": (255, 93, 115), "mechanim": (150, 170, 210), "syndics": (160, 120, 255)}
for i, (name, c) in enumerate(RACES.items()):
    # tiny ship (the dots that flit around the system view)
    W, H = 32, 20
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    cy = H // 2
    style = i % 3
    if style == 0:
        d.polygon([(4, cy), (24, cy - 6), (28, cy), (24, cy + 6)], fill=c + (255,), outline=darken(c, .4) + (255,))
    elif style == 1:
        d.polygon([(4, cy - 5), (26, cy), (4, cy + 5)], fill=c + (255,), outline=darken(c, .4) + (255,))
    else:
        d.rounded_rectangle([6, cy - 5, 24, cy + 5], radius=4, fill=c + (255,), outline=darken(c, .4) + (255,))
    d.ellipse([2, cy - 2, 6, cy + 2], fill=(120, 200, 255, 230))   # engine glow
    img.save(out("raceships", f"{name}.png"))
    # station
    S = 64
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
    cx = cy = S // 2
    d.ellipse([cx - 20, cy - 5, cx + 20, cy + 5], outline=c + (220,), width=2)        # ring
    d.line([cx - 22, cy, cx + 22, cy], fill=darken(c, .2) + (220,), width=2)          # spar
    d.line([cx, cy - 22, cx, cy + 22], fill=darken(c, .2) + (220,), width=2)
    d.rectangle([cx - 7, cy - 7, cx + 7, cy + 7], fill=lighten(c, .15) + (255,), outline=darken(c, .4) + (255,))
    d.ellipse([cx - 3, cy - 3, cx + 3, cy + 3], fill=(255, 240, 180, 255))
    img.save(out("stations", f"{name}.png"))

# ---- NEBULA BACKGROUNDS (system-view backdrops) ----------------------------
NEBULAE = {"blue": (40, 70, 140), "red": (150, 50, 70), "green": (40, 130, 90),
           "purple": (110, 60, 150), "gold": (150, 120, 50), "void": (40, 45, 70)}
for name, hue in NEBULAE.items():
    W, H = 640, 360
    img = Image.new("RGBA", (W, H), (6, 8, 16, 255)); d = ImageDraw.Draw(img)
    blob = Image.new("RGBA", (W, H), (0, 0, 0, 0)); bd = ImageDraw.Draw(blob)
    for _ in range(60):
        x, y = random.randint(0, W), random.randint(0, H)
        rr = random.randint(40, 140)
        a = random.randint(6, 22)
        col = random.choice([hue, lighten(hue, .3), darken(hue, .3)])
        bd.ellipse([x - rr, y - rr, x + rr, y + rr], fill=col + (a,))
    img = Image.alpha_composite(img, blob); d = ImageDraw.Draw(img)
    for _ in range(220):   # starfield
        x, y = random.randint(0, W), random.randint(0, H)
        b = random.randint(120, 255)
        d.point((x, y), fill=(b, b, b, 255))
    img.save(out("nebula", f"{name}.png"))

# ---- ASTEROIDS (belt decoration, transparent) ------------------------------
img = Image.new("RGBA", (128, 128), (0, 0, 0, 0)); d = ImageDraw.Draw(img)
for _ in range(26):
    x, y = random.randint(4, 124), random.randint(4, 124)
    rr = random.randint(2, 7)
    g = random.randint(90, 160)
    d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(g, g - 10, g - 20, 255), outline=(40, 40, 50, 255))
img.save(out("space", "asteroids.png"))

print("placeholders generated")
