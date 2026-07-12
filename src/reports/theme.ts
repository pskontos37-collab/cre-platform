import { Font } from '@react-pdf/renderer'

// ── M&J Wilkow corporate palette — keep in sync with ReceivablesPage.tsx ─────
export const WILKOW = '#466371'
export const WILKOW_MIST = '#8fa2ad'
export const GREEN = '#4e8f60'
export const TEXT = '#1d2429'
export const TEXT_MUTED = '#5b6a73'
export const TEXT_FAINT = '#8a949b'
export const RULE = '#dde3e7'

export const BUCKETS = [
  { key: 'current', label: 'Current', color: WILKOW },
  { key: 'b30', label: '30 Days', color: '#c2a35a' },
  { key: 'b60', label: '60 Days', color: '#cf8544' },
  { key: 'b90', label: '90 Days', color: '#c25b52' },
  { key: 'b120', label: '120+ Days', color: '#8e3d3d' },
] as const

export type BucketKey = (typeof BUCKETS)[number]['key']

// Corporate serif for titles and figures. Static TTF instances live in
// public/fonts/ (react-pdf embeds raw font files; the Google Fonts CSS
// link in index.html only covers the DOM).
export const SERIF = 'Frank Ruhl Libre'
Font.register({
  family: SERIF,
  fonts: [
    { src: '/fonts/FrankRuhlLibre-Medium.ttf', fontWeight: 500 },
    { src: '/fonts/FrankRuhlLibre-Bold.ttf', fontWeight: 700 },
  ],
})

// Tenant and legal-entity names read better unbroken
Font.registerHyphenationCallback(word => [word])

// The PDF body font is Helvetica, which only covers WinAnsi (CP1252). Map the
// symbols that show up in abstracted DB text to ASCII, render negative dollar
// amounts in the app's parenthesized house style, then drop anything outside
// the encoding so it can't render as a wrong glyph. The whitelist tail keeps
// the WinAnsi characters that live above U+00FF (dashes, curly quotes, bullet,
// ellipsis, euro, trademark, etc.).
export const pdfSafe = (s: string) => s
  .replace(/→/g, '->')   // →
  .replace(/←/g, '<-')   // ←
  .replace(/−/g, '-')    // − (Unicode minus) -> ASCII, so the currency rule below catches it
  .replace(/≥/g, '>=')   // ≥
  .replace(/≤/g, '<=')   // ≤
  .replace(/×/g, 'x')    // ×
  // Negative dollar amounts embedded in notes render in the app's parenthesized
  // house style: "credit -$12,676.95 outstanding" -> "credit ($12,676.95) outstanding".
  .replace(/-\s?\$\s?([\d,]+(?:\.\d+)?)/g, '($$$1)')
  .replace(/[^\t\n\r\x20-\xFFŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™]/g, '')

export const fmt = (n: number) => {
  const s = Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  return n < 0 ? `(${s})` : s
}

export const fmtCents = (n: number) => {
  const s = Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
  return n < 0 ? `(${s})` : s
}
