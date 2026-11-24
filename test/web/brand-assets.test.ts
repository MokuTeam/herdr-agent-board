// MokuBoard brand asset & PWA icon verification (#705): manifest metadata, SVG hygiene,
// PNG dimensions, brand palette pixels, and W3C 80% maskable safe-zone bounds.
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'

const ROOT = join(import.meta.dir, '..', '..')
const WEB = join(ROOT, 'web')
const BRAND_DIR = join(ROOT, 'docs', 'brand')

interface DecodedPng {
  width: number
  height: number
  colorType: number
  data: Uint8Array
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Decodes an 8-bit RGB (colorType 2) or RGBA (colorType 6) PNG into flat RGBA pixels. */
function decodePng(file: string): DecodedPng {
  const buf = readFileSync(file)
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < sig.length; i++) expect(buf[i]).toBe(sig[i])

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Buffer[] = []
  let pos = 8
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii')
    const chunk = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      bitDepth = chunk[8] ?? 0
      colorType = chunk[9] ?? 0
    } else if (type === 'IDAT') {
      idat.push(chunk)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  expect(bitDepth).toBe(8)
  expect([2, 6]).toContain(colorType)

  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const raw = inflateSync(Buffer.concat(idat))
  const unpacked = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0
    const rowIn = y * (stride + 1) + 1
    const rowOut = y * stride
    for (let i = 0; i < stride; i++) {
      const x = raw[rowIn + i] ?? 0
      const a = i >= bpp ? (unpacked[rowOut + i - bpp] ?? 0) : 0
      const b = y > 0 ? (unpacked[rowOut - stride + i] ?? 0) : 0
      const c = y > 0 && i >= bpp ? (unpacked[rowOut - stride + i - bpp] ?? 0) : 0
      let val = x
      if (filter === 1) val = (x + a) & 0xff
      else if (filter === 2) val = (x + b) & 0xff
      else if (filter === 3) val = (x + ((a + b) >> 1)) & 0xff
      else if (filter === 4) val = (x + paeth(a, b, c)) & 0xff
      unpacked[rowOut + i] = val
    }
  }

  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const src = i * bpp
    const dst = i * 4
    rgba[dst] = unpacked[src] ?? 0
    rgba[dst + 1] = unpacked[src + 1] ?? 0
    rgba[dst + 2] = unpacked[src + 2] ?? 0
    rgba[dst + 3] = bpp === 4 ? (unpacked[src + 3] ?? 255) : 255
  }
  return { width, height, colorType, data: rgba }
}

const pixelAt = (png: DecodedPng, x: number, y: number): [number, number, number, number] => {
  const o = (y * png.width + x) * 4
  return [png.data[o] ?? 0, png.data[o + 1] ?? 0, png.data[o + 2] ?? 0, png.data[o + 3] ?? 0]
}

const nearRgb = (rgb: [number, number, number, number], target: [number, number, number], tol = 14): boolean =>
  Math.abs(rgb[0] - target[0]) <= tol && Math.abs(rgb[1] - target[1]) <= tol && Math.abs(rgb[2] - target[2]) <= tol

function hasColor(png: DecodedPng, target: [number, number, number]): boolean {
  for (let i = 0; i < png.data.length; i += 4) {
    const a = png.data[i + 3] ?? 0
    if (a < 240) continue
    if (nearRgb([png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0, a], target, 10)) return true
  }
  return false
}

const OBSIDIAN: [number, number, number] = [0x0a, 0x0a, 0x10]
const LAVENDER_INK: [number, number, number] = [0xee, 0xee, 0xff]
const MOKU_VIOLET: [number, number, number] = [0xb0, 0x6f, 0xff]

describe('MokuBoard brand assets (#705)', () => {
  test('manifest.webmanifest carries MokuBoard name, theme colors, and existing icon files', () => {
    const manifest = JSON.parse(readFileSync(join(WEB, 'manifest.webmanifest'), 'utf8')) as {
      name: string
      short_name: string
      background_color: string
      theme_color: string
      icons: { src: string; sizes: string; purpose?: string }[]
    }
    expect(manifest.name).toBe('MokuBoard')
    expect(manifest.short_name).toBe('MokuBoard')
    expect(manifest.background_color).toBe('#f6f6f4')
    expect(manifest.theme_color).toBe('#f6f6f4')
    expect(manifest.icons.length).toBeGreaterThanOrEqual(4)
    for (const icon of manifest.icons) {
      expect(existsSync(join(WEB, icon.src))).toBe(true)
    }
  })

  test('web/icon.svg uses the Direction B Moku Frame geometry and moku-home palette without gradients', () => {
    const svg = readFileSync(join(WEB, 'icon.svg'), 'utf8')
    expect(svg).toContain('viewBox="0 0 64 64"')
    expect(svg).toContain('#0a0a10')
    expect(svg).toContain('#1a1a2e')
    expect(svg).toContain('#eeeeff')
    expect(svg).toContain('#b06fff')
    expect(svg).not.toMatch(/linearGradient|radialGradient/i)
    for (const legacy of ['#34C759', '#FF9500', '#AF52DE', '#1c1c1e']) {
      expect(svg).not.toContain(legacy)
    }
  })

  test('icon-192.png and icon-512.png have expected dimensions, transparent corners, and brand colors', () => {
    for (const [file, size] of [
      ['icon-192.png', 192],
      ['icon-512.png', 512],
    ] as const) {
      const png = decodePng(join(WEB, file))
      expect([png.width, png.height]).toEqual([size, size])
      // Rounded-square tile leaves corners transparent
      expect(pixelAt(png, 0, 0)[3]).toBe(0)
      expect(pixelAt(png, size - 1, size - 1)[3]).toBe(0)
      expect(hasColor(png, OBSIDIAN)).toBe(true)
      expect(hasColor(png, LAVENDER_INK)).toBe(true)
      expect(hasColor(png, MOKU_VIOLET)).toBe(true)
    }
  })

  test('icon-maskable-512.png keeps all foreground pixels inside the W3C 80% safe circle', () => {
    const png = decodePng(join(WEB, 'icon-maskable-512.png'))
    expect([png.width, png.height]).toEqual([512, 512])
    expect(nearRgb(pixelAt(png, 0, 0), OBSIDIAN, 2)).toBe(true)
    expect(nearRgb(pixelAt(png, 511, 511), OBSIDIAN, 2)).toBe(true)
    expect(hasColor(png, LAVENDER_INK)).toBe(true)
    expect(hasColor(png, MOKU_VIOLET)).toBe(true)

    const cx = 255.5
    const cy = 255.5
    const safeRadius = 512 * 0.4
    let maxDist = 0
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 512; x++) {
        const px = pixelAt(png, x, y)
        expect(px[3]).toBe(255)
        if (!nearRgb(px, OBSIDIAN, 12)) {
          const d = Math.hypot(x - cx, y - cy)
          if (d > maxDist) maxDist = d
        }
      }
    }
    expect(maxDist).toBeGreaterThan(80)
    expect(maxDist).toBeLessThanOrEqual(safeRadius)
  })

  test('apple-touch-icon.png is 180x180 opaque obsidian with centered Moku Frame mark', () => {
    const png = decodePng(join(WEB, 'apple-touch-icon.png'))
    expect([png.width, png.height]).toEqual([180, 180])
    expect(pixelAt(png, 0, 0)[3]).toBe(255)
    expect(nearRgb(pixelAt(png, 0, 0), OBSIDIAN, 2)).toBe(true)
    expect(hasColor(png, LAVENDER_INK)).toBe(true)
    expect(hasColor(png, MOKU_VIOLET)).toBe(true)
  })

  test('docs/brand/ documents brand guidelines and provides all 6 standalone SVGs', () => {
    const readme = readFileSync(join(BRAND_DIR, 'README.md'), 'utf8')
    expect(readme).toContain('# MokuBoard Brand Guidelines')
    expect(readme).toContain('#7b2fff')
    expect(readme).toContain('#b06fff')
    expect(readme).toContain('#0a0a10')

    const svgs = [
      'mokuboard-mark-light.svg',
      'mokuboard-mark-dark.svg',
      'mokuboard-mark-mono.svg',
      'mokuboard-app-icon.svg',
      'mokuboard-lockup-light.svg',
      'mokuboard-lockup-dark.svg',
    ]
    for (const name of svgs) {
      const text = readFileSync(join(BRAND_DIR, 'assets', name), 'utf8')
      expect(text).toContain('<svg ')
      expect(text).toContain('viewBox=')
      expect(text).not.toMatch(/linearGradient|radialGradient/i)
    }
    expect(readFileSync(join(BRAND_DIR, 'assets', 'mokuboard-mark-mono.svg'), 'utf8')).not.toContain('#')
  })
})
