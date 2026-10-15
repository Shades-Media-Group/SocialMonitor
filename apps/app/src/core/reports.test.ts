import { describe, expect, it } from 'vitest'
import { contrast, textOn, validColor } from './color.ts'
import { sniff } from './branding.ts'

describe('report branding', () => {
  it('accepts hex colours only', () => {
    expect(validColor('#1A6BD6')).toBe('#1a6bd6')
    expect(validColor('abc')).toBe('#aabbcc')
    expect(validColor(' #0f0 ')).toBe('#00ff00')
    for (const bad of ['', 'red', '#12345', '#1234567', '#ggg000', 'rgb(0,0,0)', null, 42])
      expect(validColor(bad)).toBeNull()
  })

  it('puts text on the accent only where it reads at 4.5:1', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21)
    expect(textOn('#0a2a6b')).toBe('#ffffff')
    expect(textOn('#ffe600')).toBe('#16181d')
    // A mid grey reads with neither paper nor ink: rules and marks only.
    expect(textOn('#7c7c7c')).toBeNull()
    for (const c of ['#0a2a6b', '#ffe600', '#f9000a', '#00a86b', '#767676']) {
      const on = textOn(c)
      if (on) expect(contrast(on, c)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('knows a logo by its bytes, not its name', () => {
    expect(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('png')
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg')
    expect(sniff(Buffer.from('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>'))).toBe('svg')
    expect(sniff(Buffer.from(String.fromCharCode(0xfeff) + '<!-- logo --><svg xmlns="x">'))).toBe(
      'svg',
    )
    expect(sniff(Buffer.from('<html><svg></svg></html>'))).toBeNull()
    expect(sniff(Buffer.from('GIF89a'))).toBeNull()
  })
})
