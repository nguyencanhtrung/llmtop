"""Build the llmtop logo kit (direction D: donut "o").

Usage: python3 -I build_brand.py <font_dir> <out_dir>
font_dir holds roboto-mono-latin-{400,700}-normal.woff
"""
import json, math, os, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

font_dir, out = sys.argv[1], sys.argv[2]
os.makedirs(os.path.join(out, "svg"), exist_ok=True)

F = {w: TTFont(os.path.join(font_dir, f"roboto-mono-latin-{w}-normal.woff")) for w in ("400", "700")}
UPM = 2048
ADV = 1229
XH = 1082

INK = {"light": ["#1A1A1A", "#3F3F3F", "#7F7F7F", "#D8D8D8"],   # on light grounds
       "dark":  ["#FFFFFF", "#D8D8D8", "#888888", "#3F3F3F"]}   # on dark grounds
TEXT = {"light": "#1A1A1A", "dark": "#FFFFFF"}
TILE = {"dark": "#1A1A1A", "light": "#F2F2F2"}
SEGMENTS = [0.38, 0.26, 0.16, 0.08]   # share of the ring, clockwise from 12 o'clock
GAP = 0.03


def glyph_path(weight, ch, x, baseline, scale):
    f = F[weight]
    gs = f.getGlyphSet()
    name = f.getBestCmap()[ord(ch)]
    pen = SVGPathPen(gs)
    gs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
    return pen.getCommands()


def glyph_bounds(weight, ch):
    f = F[weight]
    gs = f.getGlyphSet()
    bp = BoundsPen(gs)
    gs[f.getBestCmap()[ord(ch)]].draw(bp)
    return bp.bounds


def arc(cx, cy, r, a0, a1):
    """Clockwise arc from fraction a0 to a1 of a turn, 0 = 12 o'clock."""
    def pt(a):
        t = 2 * math.pi * a - math.pi / 2
        return cx + r * math.cos(t), cy + r * math.sin(t)
    x0, y0 = pt(a0)
    x1, y1 = pt(a1)
    large = 1 if (a1 - a0) > 0.5 else 0
    return f"M{x0:.3f} {y0:.3f}A{r:.3f} {r:.3f} 0 {large} 1 {x1:.3f} {y1:.3f}"


def donut(cx, cy, r, sw, colors, segs=SEGMENTS, gap=GAP):
    out, a = [], 0.0
    for frac, col in zip(segs, colors):
        out.append(f'<path d="{arc(cx, cy, r, a, a + frac)}" fill="none" stroke="{col}" stroke-width="{sw:.3f}"/>')
        a += frac + gap
    return "".join(out)


def svg(w, h, body, label):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:g}" height="{h:g}" viewBox="0 0 {w:g} {h:g}" '
            f'role="img" aria-label="{label}"><title>{label}</title>{body}</svg>\n')


def write(name, content):
    with open(os.path.join(out, "svg", name), "w") as fh:
        fh.write(content)


# ---------- mark (64 grid) ----------
def mark_body(theme, size=64):
    s = size / 64
    tile = f'<rect width="{size:g}" height="{size:g}" rx="{14*s:g}" fill="{TILE[theme]}"/>'
    ring_colors = INK["dark"] if theme == "dark" else INK["light"]
    return tile + donut(32 * s, 32 * s, 16 * s, 8 * s, ring_colors)


write("llmtop-mark.svg", svg(64, 64, mark_body("dark"), "llmtop"))
write("llmtop-mark-light.svg", svg(64, 64, mark_body("light"), "llmtop"))

# glyph only, single colour via currentColor (theme it in CSS)
glyph = ""
a = 0.0
for frac, op in zip(SEGMENTS, (1, 0.72, 0.45, 0.18)):
    glyph += f'<path d="{arc(32, 32, 22, a, a + frac)}" fill="none" stroke="currentColor" stroke-opacity="{op}" stroke-width="12"/>'
    a += frac + GAP
write("llmtop-glyph.svg", svg(64, 64, glyph, "llmtop"))

# favicon: simplified 3-segment ring, thicker, wider gaps (reads at 16 px)
fav = f'<rect width="64" height="64" rx="14" fill="{TILE["dark"]}"/>' + donut(
    32, 32, 17, 12, ["#FFFFFF", "#D8D8D8", "#888888"], segs=[0.46, 0.28, 0.14], gap=0.04)
write("favicon.svg", svg(64, 64, fav, "llmtop"))

# ---------- wordmark: llm(400) t(700) [donut] p(700) ----------
FS = 100                      # font size in svg units
sc = FS / UPM
adv = ADV * sc
track = -0.03 * FS
ob = glyph_bounds("700", "o")  # (xmin, ymin, xmax, ymax) in font units
o_h = (ob[3] - ob[1]) * sc
o_cy_font = (ob[3] + ob[1]) / 2
o_w = (ob[2] - ob[0]) * sc
asc = 1456 * sc                # cap height, for vertical box
desc = 555 * sc * 0.75
pad = 0
baseline = asc + 4
height = baseline + desc


def wordmark_body(theme, x0=0.0, y0=0.0):
    col = TEXT[theme]
    paths, x = [], x0
    for ch, w in (("l", "400"), ("l", "400"), ("m", "400"), ("t", "700"), ("o", "700"), ("p", "700")):
        if ch == "o":
            ring_colors = INK["light"] if theme == "light" else INK["dark"]
            outer = max(o_h, o_w) / 2 + 0.6
            sw = 13.5
            cx = x + adv / 2
            cy = y0 + baseline - o_cy_font * sc
            paths.append(donut(cx, cy, outer - sw / 2, sw, ring_colors))
        else:
            d = glyph_path(w, ch, x, y0 + baseline, sc)
            paths.append(f'<path d="{d}" fill="{col}"/>')
        x += adv + track
    return "".join(paths), x - track - x0


wm_light, wm_w = wordmark_body("light")
wm_dark, _ = wordmark_body("dark")
write("llmtop-wordmark.svg", svg(round(wm_w, 2), round(height, 2), wm_light, "llmtop"))
write("llmtop-wordmark-reversed.svg", svg(round(wm_w, 2), round(height, 2), wm_dark, "llmtop"))

# ---------- horizontal lockup: mark + wordmark ----------
mark_size = round(height * 1.0)
gapx = mark_size * 0.28


def lockup(theme):
    tile_theme = "dark" if theme == "light" else "light"
    m = f'<g>{mark_body(tile_theme, mark_size)}</g>'
    wm, _ = wordmark_body(theme, x0=mark_size + gapx, y0=(mark_size - height) / 2)
    return m + wm


lw = round(mark_size + gapx + wm_w, 2)
write("llmtop-lockup.svg", svg(lw, mark_size, lockup("light"), "llmtop"))
write("llmtop-lockup-reversed.svg", svg(lw, mark_size, lockup("dark"), "llmtop"))

# ---------- tokens ----------
tokens = {
    "name": "llmtop",
    "direction": "D — donut o",
    "fonts": {"wordmark": "Roboto Mono", "weights": {"llm": 400, "top": 700},
              "letterSpacingEm": -0.03, "ui": "Montserrat"},
    "colors": {
        "ink": "#1A1A1A", "paper": "#F2F2F2", "white": "#FFFFFF", "black": "#000000",
        "tileDark": TILE["dark"], "tileLight": TILE["light"],
        "donutOnLight": INK["light"], "donutOnDark": INK["dark"],
    },
    "donut": {"segments": SEGMENTS, "gap": GAP, "startAngle": "12 o'clock", "direction": "clockwise",
              "meaning": "share of usage across providers, largest first; the last segment is 'others' (e.g. local models)"},
    "mark": {"grid": 64, "cornerRadius": 14, "ringRadius": 16, "ringStroke": 8},
    "favicon": {"segments": [0.46, 0.28, 0.14], "gap": 0.04, "ringRadius": 17, "ringStroke": 12},
    "clearSpace": "0.25 × mark height on every side",
    "minSize": {"mark": "16px (use favicon.svg below 32px)", "wordmark": "80px wide", "lockup": "120px wide"},
}
with open(os.path.join(out, "brand.json"), "w") as fh:
    json.dump(tokens, fh, indent=2)
print("ok", lw, wm_w, height)
