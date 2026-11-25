// The machine marker on cards (#789, src/core/device-marker.ts) and the palette beside it
// (src/core/device-color.ts): how `nodes.marker` reads, how config.json keeps it, the classes a
// card draws for each style, place and size (the default exactly #758's corner), and the palette's
// new swatches leaving every automatic colour where main put it.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTO_COLOR_COUNT,
  DEVICE_COLORS,
  deviceColorFallback,
  normalizeDeviceColor,
  resolveDeviceColors,
} from '../../src/core/device-color.ts'
import {
  CORNER_POSITIONS,
  DEFAULT_MARKER,
  deviceMarkerOf,
  isDefaultMarker,
  MARKER_SIZES,
  markerClasses,
  markerConfigOf,
  markerOrDefault,
  STRIPE_POSITIONS,
} from '../../src/core/device-marker.ts'
import { root } from '../support/sandbox.ts'

describe('deviceMarkerOf', () => {
  test('an absent key takes the default: the style’s own place, medium', () => {
    expect(deviceMarkerOf({})).toEqual(DEFAULT_MARKER)
    expect(DEFAULT_MARKER).toEqual({ style: 'corner', position: 'bottom-right', size: 'medium' })
    expect(deviceMarkerOf({ style: 'stripe' })).toEqual({ style: 'stripe', position: 'left', size: 'medium' })
    expect(deviceMarkerOf({ style: 'corner', position: null, size: null })).toEqual(DEFAULT_MARKER)
    expect(deviceMarkerOf({ size: 'large' })).toEqual({ ...DEFAULT_MARKER, size: 'large' })
  })

  test('each style takes only its own places', () => {
    for (const position of CORNER_POSITIONS) {
      expect(deviceMarkerOf({ style: 'corner', position })?.position).toBe(position)
      expect(deviceMarkerOf({ style: 'stripe', position })).toBeNull()
    }
    for (const position of STRIPE_POSITIONS) {
      expect(deviceMarkerOf({ style: 'stripe', position })?.position).toBe(position)
      expect(deviceMarkerOf({ style: 'corner', position })).toBeNull()
    }
  })

  test('anything else is no marker: never guessed at', () => {
    for (const raw of [
      null,
      'corner',
      [],
      { style: 'ribbon' },
      { size: 'huge' },
      { size: 2 },
      { position: 'middle' },
      { style: 'corner', extra: 1 },
      { style: 'Corner' },
    ])
      expect(deviceMarkerOf(raw)).toBeNull()
    expect(markerOrDefault(undefined)).toEqual(DEFAULT_MARKER)
    expect(markerOrDefault({ style: 'ribbon' })).toEqual(DEFAULT_MARKER)
  })
})

describe('markerConfigOf', () => {
  test('config.json keeps only what differs; today’s corner keeps nothing', () => {
    expect(markerConfigOf(DEFAULT_MARKER)).toBeNull()
    expect(markerConfigOf({ style: 'stripe', position: 'left', size: 'medium' })).toEqual({ style: 'stripe' })
    expect(markerConfigOf({ style: 'stripe', position: 'top', size: 'small' })).toEqual({
      style: 'stripe',
      position: 'top',
      size: 'small',
    })
    expect(markerConfigOf({ style: 'corner', position: 'top-left', size: 'medium' })).toEqual({ position: 'top-left' })
    expect(markerConfigOf({ style: 'off', position: 'top', size: 'large' })).toEqual({ style: 'off' })
  })

  test('what it keeps reads back as the same marker', () => {
    for (const position of CORNER_POSITIONS)
      for (const size of MARKER_SIZES) {
        const m = { style: 'corner' as const, position, size }
        expect(deviceMarkerOf(markerConfigOf(m) ?? {})).toEqual(m)
      }
    for (const position of STRIPE_POSITIONS)
      for (const size of MARKER_SIZES) {
        const m = { style: 'stripe' as const, position, size }
        expect(deviceMarkerOf(markerConfigOf(m) ?? {})).toEqual(m)
      }
    expect(isDefaultMarker(DEFAULT_MARKER)).toBe(true)
    expect(isDefaultMarker({ ...DEFAULT_MARKER, size: 'small' })).toBe(false)
  })
})

describe('markerClasses', () => {
  test('the default is exactly #758’s corner element', () => {
    expect(markerClasses(DEFAULT_MARKER)).toEqual(['card-device-corner'])
  })

  test('each place and size of the corner', () => {
    expect(markerClasses({ style: 'corner', position: 'top-left', size: 'medium' })).toEqual([
      'card-device-corner',
      'at-top-left',
    ])
    expect(markerClasses({ style: 'corner', position: 'top-right', size: 'small' })).toEqual([
      'card-device-corner',
      'at-top-right',
      'size-small',
    ])
    expect(markerClasses({ style: 'corner', position: 'bottom-right', size: 'large' })).toEqual([
      'card-device-corner',
      'size-large',
    ])
  })

  test('the stripe always names its side; off draws nothing', () => {
    for (const position of STRIPE_POSITIONS)
      expect(markerClasses({ style: 'stripe', position, size: 'medium' })).toEqual([
        'card-device-stripe',
        `at-${position}`,
      ])
    expect(markerClasses({ style: 'stripe', position: 'bottom', size: 'small' })).toEqual([
      'card-device-stripe',
      'at-bottom',
      'size-small',
    ])
    expect(markerClasses({ style: 'off', position: 'bottom-right', size: 'medium' })).toBeNull()
  })
})

describe('the palette (#789)', () => {
  test('twelve swatches, distinct, each a valid colour id', () => {
    expect(DEVICE_COLORS).toHaveLength(12)
    expect(new Set(DEVICE_COLORS.map(s => s.id)).size).toBe(12)
    expect(new Set(DEVICE_COLORS.map(s => s.hex.toLowerCase())).size).toBe(12)
    for (const s of DEVICE_COLORS) expect(normalizeDeviceColor(s.id)).toBe(s.id)
    expect(AUTO_COLOR_COUNT).toBe(7)
  })

  test('the automatic colours are main’s, device for device: the new swatches move no one', async () => {
    // main's device-color.ts, run beside this one.
    const git = Bun.spawnSync(['git', 'show', '4a9efdd3:src/core/device-color.ts'], { cwd: root })
    expect(git.exitCode).toBe(0)
    const dir = mkdtempSync(join(tmpdir(), 'device-color-main-'))
    writeFileSync(join(dir, 'device-color.ts'), git.stdout.toString())
    const main = (await import(join(dir, 'device-color.ts'))) as typeof import('../../src/core/device-color.ts')
    const sets = [
      [{ id: 'local', selfId: 'atlas' }, { id: 'ben' }],
      [{ id: 'local', selfId: 'atlas' }, { id: 'ben' }, { id: 'cleo' }, { id: 'server-1' }, { id: 'Сервер 50%' }],
      [{ id: 'local' }, { id: 'ben', color: 'rose' }, { id: 'cleo' }, { id: 'anna', color: '#123456' }],
      Array.from({ length: 10 }, (_, i) => ({ id: `dev-${i}` })),
    ]
    for (const devices of sets) {
      const now = Object.fromEntries(resolveDeviceColors(devices))
      const was = Object.fromEntries(main.resolveDeviceColors(devices))
      expect(now).toEqual(was)
    }
    for (const key of ['atlas', 'ben', 'pane-12', 'C:\\Users\\o w', 'Тест 50%'])
      expect(deviceColorFallback(key)).toEqual(main.deviceColorFallback(key))
  })

  test('a device may pick one of the new swatches by hand; the automatic ones keep clear of it only when it is theirs', () => {
    const colors = resolveDeviceColors([{ id: 'local' }, { id: 'ben', color: 'wine' }])
    expect(colors.get('ben')).toEqual({ id: 'wine', hex: '#9E3D52' })
    const auto = DEVICE_COLORS.slice(0, AUTO_COLOR_COUNT).map(s => s.id)
    expect(auto).toContain(colors.get('local')?.id ?? '')
  })
})
