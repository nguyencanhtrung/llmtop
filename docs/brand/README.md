# llmtop — logo kit (Direction D: donut "o")

llmtop is a statistics tool for LLM usage (Claude, Codex, Antigravity, local models, and more).
In the logo, the "o" of the wordmark is drawn as a donut chart: usage shared across providers. The mark is the same donut on a rounded tile.

All artwork is monochrome. Text in the SVGs is converted to outlines, so no font has to be installed to display it.

## Files

| File | Use |
|---|---|
| `svg/llmtop-lockup.svg` | Main logo: mark + wordmark, for **light** backgrounds |
| `svg/llmtop-lockup-reversed.svg` | Main logo for **dark** backgrounds |
| `svg/llmtop-wordmark.svg` | Wordmark only, light backgrounds |
| `svg/llmtop-wordmark-reversed.svg` | Wordmark only, dark backgrounds |
| `svg/llmtop-mark.svg` | App icon / avatar, dark tile (default) |
| `svg/llmtop-mark-light.svg` | App icon on a light tile |
| `svg/llmtop-glyph.svg` | Donut only, single colour via `currentColor` (inline in UI, inherits text colour) |
| `svg/favicon.svg` | Simplified 3-segment donut for 16–32 px |
| `favicon.ico` | 16/32/48 px, for browsers that need .ico |
| `png/favicon-{16,32,48}.png` | Raster favicons |
| `png/apple-touch-icon.png` | 180×180 |
| `png/llmtop-mark-{192,512,1024}.png` | PWA manifest / store icons |
| `png/llmtop-lockup@2x.png`, `png/llmtop-lockup-reversed@2x.png`, `png/llmtop-wordmark@2x.png` | Raster logos for places that cannot take SVG |
| `brand.json` | Colours, fonts, donut geometry and usage rules as data |
| `source/build_brand.py` | Script that regenerates every SVG from the spec (needs Roboto Mono .woff files) |

## Rules

- **Colours:** monochrome only. Ink `#1A1A1A`, paper `#F2F2F2`, white `#FFFFFF`, black `#000000`.
  Donut segments, largest first, clockwise from 12 o'clock:
  - on light: `#1A1A1A`, `#3F3F3F`, `#7F7F7F`, `#D8D8D8`
  - on dark: `#FFFFFF`, `#D8D8D8`, `#888888`, `#3F3F3F`
- **Typography:** wordmark is Roboto Mono, "llm" Regular 400 + "top" Bold 700, letter-spacing −0.03em. Any surrounding UI text uses Montserrat (400/700).
- **Clear space:** at least 0.25 × the mark's height on every side.
- **Minimum size:** lockup 120 px wide; wordmark 80 px wide; below 32 px use `favicon.svg`, not `llmtop-mark.svg`.
- **Do not:** recolour the segments, add gradients or shadows, rotate or stretch the logo, re-type the wordmark in another font, or use the theme accents clay/ochre/amber.
- The donut is a symbol, not live data: do not animate segment sizes to real stats unless explicitly designing a data view.

## Integration snippets

**HTML `<head>`**
```html
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#1A1A1A">
```

**site.webmanifest**
```json
{
  "name": "llmtop",
  "short_name": "llmtop",
  "icons": [
    { "src": "/llmtop-mark-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/llmtop-mark-512.png", "sizes": "512x512", "type": "image/png" }
  ],
  "theme_color": "#1A1A1A",
  "background_color": "#F2F2F2",
  "display": "standalone"
}
```

**GitHub README header (switches with the reader's theme)**
```html
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/svg/llmtop-lockup-reversed.svg">
    <img alt="llmtop" src="docs/brand/svg/llmtop-lockup.svg" width="360">
  </picture>
</p>
```

**Inline glyph that follows text colour**
```html
<span style="color:#1A1A1A; display:inline-flex; width:1em; height:1em">
  <!-- paste the contents of svg/llmtop-glyph.svg here -->
</span>
```

## Prompt for a coding agent (Codex, Claude Code, …)

> Add the llmtop logo kit from `docs/brand/` (this folder) to the project.
> 1. Copy the folder to `docs/brand/` unchanged, keeping `README.md` and `brand.json`.
> 2. Web app: copy `favicon.ico`, `svg/favicon.svg`, `png/apple-touch-icon.png`, `png/llmtop-mark-192.png`, `png/llmtop-mark-512.png` into the public/static folder; add the `<head>` tags and `site.webmanifest` from `docs/brand/README.md`.
> 3. Use `svg/llmtop-lockup.svg` in the light header and `svg/llmtop-lockup-reversed.svg` on dark themes; use `svg/llmtop-glyph.svg` inline where the logo should inherit text colour.
> 4. Put the `<picture>` header from the README at the top of the repository `README.md`.
> 5. Expose `brand.json` colours as design tokens (CSS variables or the project's theme file) instead of hard-coding hex values.
> 6. Follow the Rules section: no recolouring, no re-typing the wordmark, monochrome only. Do not edit the SVG files.
