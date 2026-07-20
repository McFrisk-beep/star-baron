#!/usr/bin/env python3
"""gen_ui_assets.py — one-time downscale of the Cyberpunk UI Asset Pack into
game-ready sprites under assets/ui/ (committed; no runtime processing).
The pack's PNGs are 1024px/500KB-class — far too heavy to ship per-button on a
static site — so this emits small optimized copies at ~2-3x display size.
Run from the repo root:  python3 tools/gen_ui_assets.py
"""
import os
from PIL import Image

PACK = "Cyberpunk_UI_Asset_Pack_v1.3"
OUT = "assets/ui"

# (source, output name, target height px)   — width scales proportionally
JOBS = [
    # nav tiles (display ~30px tall → export 3x)
    ("02_Interactive_Buttons/Menu_Button/menu_button_04.png",   "nav_exchange.png",   96),
    ("02_Interactive_Buttons/Menu_Button/menu_button_play.png", "nav_fleet.png",      96),
    ("02_Interactive_Buttons/Menu_Button/menu_button_01.png",   "nav_systems.png",    96),
    ("02_Interactive_Buttons/Menu_Button/menu_button_06.png",   "nav_bazaar.png",     96),
    ("02_Interactive_Buttons/Menu_Button/menu_button_03.png",   "nav_industries.png", 96),
    ("02_Interactive_Buttons/Menu_Button/menu_button_05.png",   "nav_senate.png",     96),
    ("02_Interactive_Buttons/Menu_Button/menu_button_02.png",   "nav_barons.png",     96),
    ("02_Interactive_Buttons/Menu_Button/menu_button01.png",    "nav_frame.png",      96),
    # primary CTA button states (display ~34px tall → export ~4x for wide stretch)
    ("02_Interactive_Buttons/Primary_Button/Btn_Primary_Normal.png",  "btn_primary.png",         148),
    ("02_Interactive_Buttons/Primary_Button/Btn_Primary_Hover.png",   "btn_primary_hover.png",   148),
    ("02_Interactive_Buttons/Primary_Button/Btn_Primary_Pressed.png", "btn_primary_pressed.png", 148),
    # cursor (browsers cap custom cursors at 128px; 32 is the safe classic)
    ("05_Cursors/cur_normal.png", "cursor.png", 32),
]

os.makedirs(OUT, exist_ok=True)
total = 0
for src, name, h in JOBS:
    im = Image.open(os.path.join(PACK, src)).convert("RGBA")
    w = round(im.width * h / im.height)
    im = im.resize((w, h), Image.LANCZOS)
    out = os.path.join(OUT, name)
    im.save(out, optimize=True)
    kb = os.path.getsize(out) // 1024
    total += kb
    print(f"{name:26s} {w}x{h}  {kb}KB")
print(f"total: {total}KB")
