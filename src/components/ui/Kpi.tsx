// Shared KPI presentation bits for dashboard widgets — hero metrics, delta and
// status pills, area sparklines, mini stat grids, and covenant gauges. Pure
// presentation: no data fetching, all colors from theme tokens.
import { ReactNode } from 'react'

// $14.98M / $938.9K / $412 — hero-sized figures read better compact.
export function fmtCompact(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`
  return `${sign}$${Math.round(abs).toLocaleString('en-US')}`
}

// Headline metric: small uppercase label, large value, optional pill beside it.
export function Hero({ label, value, pill }: { label: string; value: string; pill?: ReactNode }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 1 }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 27, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
          {value}
        </span>
        {pill}
      </div>
    </div>
  )
}

// Percent-change pill vs a prior value. Renders nothing when the comparison
// is meaningless (no prior, prior <= 0). `downIsGood` flips the colors for
// metrics where a decrease is the healthy direction (A/R, expenses).
export function DeltaPill({ current, prior, suffix, downIsGood }: {
  current: number
  prior: number | null | undefined
  suffix: string
  downIsGood?: boolean
}) {
  if (prior == null || prior <= 0) return null
  const pct = ((current - prior) / prior) * 100
  if (!isFinite(pct)) return null
  const up = pct >= 0
  const good = downIsGood ? !up : up
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 99,
      fontVariantNumeric: 'tabular-nums',
      color: good ? 'var(--green)' : 'var(--red)',
      background: good ? 'var(--green-bg)' : 'var(--red-bg)',
    }}>
      {up ? '▲' : '▼'} {Math.abs(pct).toFixed(1)}% {suffix}
    </span>
  )
}

// Small status pill (covenant state, aging warnings, …).
export function StatusPill({ tone, children }: { tone: 'ok' | 'warn' | 'bad'; children: ReactNode }) {
  const color = tone === 'ok' ? 'var(--green)' : tone === 'warn' ? 'var(--amber)' : 'var(--red)'
  const bg = tone === 'ok' ? 'var(--green-bg)' : tone === 'warn' ? 'var(--amber-bg)' : 'var(--red-bg)'
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
      color, background: bg,
    }}>
      {children}
    </span>
  )
}

// Area sparkline: line + soft fill + emphasized endpoint. `titles` (optional,
// same length as values) adds an invisible hover target with a tooltip per
// point — replacing the per-bar title attribute of the old bar charts.
export function AreaSpark({ values, titles, height = 52, color = 'var(--accent)', ariaLabel }: {
  values: number[]
  titles?: string[]
  height?: number
  color?: string
  ariaLabel: string
}) {
  if (values.length < 2) return null
  const W = 300, H = height, pad = 3
  const max = Math.max(...values), min = Math.min(...values)
  const range = max - min || 1
  const pts = values.map((v, i) => [
    pad + (i / (values.length - 1)) * (W - pad * 2),
    H - pad - ((v - min) / range) * (H - pad * 2),
  ] as const)
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  const area = `${line} L${W - pad} ${H - pad} L${pad} ${H - pad} Z`
  const last = pts[pts.length - 1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel}
      style={{ display: 'block', width: '100%', height }}>
      <path d={area} fill={color} opacity={0.13} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r={3} fill={color} />
      {titles && pts.map((p, i) => (
        <circle key={i} cx={p[0]} cy={p[1]} r={7} fill="transparent">
          <title>{titles[i]}</title>
        </circle>
      ))}
    </svg>
  )
}

// Bordered 2-up grid for secondary stats under a hero.
export function MiniGrid({ cells }: { cells: Array<{ label: string; value: string }> }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(${Math.min(cells.length, 2)}, 1fr)`, gap: 1,
      background: 'var(--border)', border: '1px solid var(--border)', borderRadius: 10,
      overflow: 'hidden', margin: '12px 0',
    }}>
      {cells.map(c => (
        <div key={c.label} style={{ background: 'var(--surface)', padding: '8px 12px' }}>
          <div style={{ fontSize: 9.5, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>
            {c.label}
          </div>
          <div style={{ fontSize: 14, fontWeight: 650, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
            {c.value}
          </div>
        </div>
      ))}
    </div>
  )
}

// Slim horizontal gauge. `frac` = fill 0..1; optional `tick` marks a threshold
// (e.g. the covenant level) as a hairline at that fraction of the track.
export function Gauge({ frac, color, tick, height = 6 }: {
  frac: number
  color: string
  tick?: number
  height?: number
}) {
  const clamped = Math.max(0, Math.min(1, frac))
  return (
    <div style={{ position: 'relative', height, borderRadius: 99, background: 'var(--surface-2)', overflow: 'hidden' }}>
      <div style={{ width: `${clamped * 100}%`, height: '100%', background: color, borderRadius: 99 }} />
      {tick != null && tick > 0 && tick < 1 && (
        <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${tick * 100}%`, width: 2, background: 'var(--text-faint)', opacity: 0.8 }} />
      )}
    </div>
  )
}
