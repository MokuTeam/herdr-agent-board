# MokuBoard Brand Guidelines

Brand specification for **MokuBoard** (#705), built for the #651/#658 web board design system and the Moku corporate palette.

## The Mark (Moku Frame)

Two opposing framing brackets enclose a centered focus tile: quiet, flat geometric precision representing structured agent workspaces without generic kanban-column clichés.

- **Grid**: `64 x 64` unit viewBox (`viewBox="0 0 64 64"`).
- **Active mark bounds**: `44 x 44` units (`x: 10..54`, `y: 10..54`).
- **Bracket arm thickness**: `8` units (`4` outer corner radius, `1.5` inner terminal radius).
- **Focus tile**: `15 x 15` units centered at `(32, 32)` (`x: 24.5`, `y: 24.5`, `rx: 3.5`).
- **Uniform channel**: `6.5` units between brackets and the focus tile on all four sides.

## Assets

### Standalone Brand SVGs (`docs/brand/assets/`)
- [mokuboard-mark-light.svg](assets/mokuboard-mark-light.svg) - transparent mark for light surfaces (`#18181b` + `#7b2fff`).
- [mokuboard-mark-dark.svg](assets/mokuboard-mark-dark.svg) - transparent mark for dark surfaces (`#eeeeff` + `#b06fff`).
- [mokuboard-mark-mono.svg](assets/mokuboard-mark-mono.svg) - single-color `currentColor` mask.
- [mokuboard-app-icon.svg](assets/mokuboard-app-icon.svg) - rounded obsidian app tile (`#0a0a10`, `#1a1a2e` border, `#eeeeff`, `#b06fff`).
- [mokuboard-lockup-light.svg](assets/mokuboard-lockup-light.svg) - horizontal mark + `MokuBoard` wordmark for light surfaces.
- [mokuboard-lockup-dark.svg](assets/mokuboard-lockup-dark.svg) - horizontal mark + `MokuBoard` wordmark for dark surfaces.

### Web & PWA Runtime Assets (`web/`)
- `web/icon.svg` - favicon and remote gate icon (`64 x 64` app tile).
- `web/icon-192.png` - `192 x 192` RGBA PNG with transparent outer corners.
- `web/icon-512.png` - `512 x 512` RGBA PNG with transparent outer corners.
- `web/icon-maskable-512.png` - `512 x 512` opaque `#0a0a10` PNG with mark scaled to `0.72x` inside the W3C 80% safe circle.
- `web/apple-touch-icon.png` - `180 x 180` opaque `#0a0a10` PNG with mark scaled to `0.84x` for iOS home screens.
- `web/src/components/BrandMark.tsx` - React UI mark used in the `NavRail` header (`#rail-expand`).

## Colors

| Role | Token / Context | Hex | Usage |
| --- | --- | --- | --- |
| Obsidian tile | App icon / maskable bg | `#0a0a10` | App icon, maskable, Apple touch background |
| Rim hairline | App icon stroke | `#1a1a2e` | `1 u` border on `web/icon.svg` |
| Lavender ink | Dark mark / app icon | `#eeeeff` | Brackets & dark wordmark |
| Moku violet (dark) | `--brand-accent` (dark) | `#b06fff` | Focus tile on dark surfaces and app icons |
| Moku violet (light) | `--brand-accent` (light) | `#7b2fff` | Focus tile on light surfaces |
| Light ink | `--label` (light) | `#18181b` | Brackets & light wordmark |
| Light surface | `theme_color` / `--bg` | `#f6f6f4` | PWA light chrome & light backgrounds |
| Dark surface | `theme-color` / `--bg` | `#111214` | PWA dark chrome & dark backgrounds |

Note: In Terminal look (`data-look="terminal"`), `--brand-accent` maps to `--t-purple` (`#a626a4` light / `#c678dd` dark) so the rail header stays consistent with the One Light / One Dark palette.

## Clear Space & Minimum Sizes

- **Clear space**: Keep at least `0.25x` the mark's width empty on all four sides (`16 u` around the `64 u` viewBox; for `44 u` mark geometry, `10 u` minimum padding inside the `64 u` frame).
- **Maskable safe zone**: All mark pixels in `icon-maskable-512.png` stay strictly inside the central 80% diameter circle (`r <= 204.8 px` on a `512 x 512` canvas).
- **Minimum sizes**:
  - `16 x 16 px`: favicon and micro UI badges (use the app-tile `web/icon.svg` or `BrandMark` at crisp integer size).
  - `18 x 18 px`: web board `NavRail` header mark.
  - `20 px` mark height (`150 px` total width): smallest recommended horizontal wordmark lockup.

## Do and Don't

**Do**
- Use the flat corporate colors defined above or `currentColor` monochrome.
- Keep the `1:1` aspect ratio and `6.5 u` channel between the brackets and center tile.
- Pair the light mark (`#18181b` + `#7b2fff`) with light surfaces and the dark mark (`#eeeeff` + `#b06fff`) with dark surfaces.

**Don't**
- Do not add gradients, drop shadows, outer neon glows, or strokes around the brackets.
- Do not stretch, rotate, or change the thickness of the brackets or center tile.
- Do not recolor the focus tile into live status colors (`--green`, `--orange`, `--red`).
- Do not crop inside the `0.25x` clear space or place mark geometry outside the 80% maskable safe circle.
