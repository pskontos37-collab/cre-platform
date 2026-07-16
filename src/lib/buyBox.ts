// buyBox.ts — score how well a pipeline deal matches an acquisition "buy-box"
// (the firm's target criteria). Pure, testable. Used to surface on-strategy vs
// off-strategy deal flow and to steer sourcing.
//
// Criteria split into HARD (asset type / risk profile / geography) — a set-and-
// failed hard criterion DISQUALIFIES the deal for that buy-box — and SOFT
// (price / GLA / going-in cap / IRR / equity multiple), which contribute to the
// fit score. A criterion the buy-box doesn't set is skipped; a criterion the deal
// has no value for is 'unknown' (excluded from the score denominator, but shown).

import type { AssetType, RiskProfile } from '../hooks/usePipeline'

export interface BuyBox {
  id: string
  name: string
  assetTypes: AssetType[]        // empty = any
  riskProfiles: RiskProfile[]    // empty = any
  states: string[]               // empty = any (2-letter, upper)
  markets: string[]              // empty = any (free-text market names)
  minPrice: number | null
  maxPrice: number | null
  minGla: number | null
  maxGla: number | null
  minGoingInCap: number | null
  maxGoingInCap: number | null
  minIrr: number | null
  minEquityMultiple: number | null
  active: boolean
  notes: string | null
}

export interface FitDeal {
  assetType: AssetType
  riskProfile: RiskProfile
  state: string | null
  market: string | null
  glaSf: number | null
  askPrice: number | null
  goingInCap: number | null
  projIrr: number | null
  equityMultiple: number | null
}

export type CheckStatus = 'pass' | 'fail' | 'unknown'
export interface FitCheck { label: string; status: CheckStatus; hard: boolean; detail?: string }
export interface FitResult {
  score: number            // 0..1 over applicable (known) checks
  disqualified: boolean    // a hard criterion (asset/risk/geo) was set and failed
  checks: FitCheck[]
  applicable: number       // known checks (pass or fail)
  passed: number
}
export type FitCategory = 'on' | 'partial' | 'off' | 'none'

const inRange = (v: number | null, min: number | null, max: number | null): CheckStatus => {
  if (v == null) return 'unknown'
  if (min != null && v < min) return 'fail'
  if (max != null && v > max) return 'fail'
  return 'pass'
}
const atLeast = (v: number | null, min: number): CheckStatus => (v == null ? 'unknown' : v >= min ? 'pass' : 'fail')
const rangeLabel = (min: number | null, max: number | null, fmt: (n: number) => string): string =>
  min != null && max != null ? `${fmt(min)}–${fmt(max)}` : min != null ? `≥ ${fmt(min)}` : max != null ? `≤ ${fmt(max)}` : ''
const fmtM = (n: number) => `$${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
const fmtPct = (n: number) => `${(n * 100).toFixed(1)}%`
const fmtSf = (n: number) => `${Math.round(n / 1000)}k SF`

/** Score one deal against one buy-box. */
export function scoreDealFit(d: FitDeal, bb: BuyBox): FitResult {
  const checks: FitCheck[] = []
  const add = (label: string, status: CheckStatus, hard: boolean, detail?: string) => checks.push({ label, status, hard, detail })

  // ── hard criteria ──
  if (bb.assetTypes.length) add('Asset type', bb.assetTypes.includes(d.assetType) ? 'pass' : 'fail', true, bb.assetTypes.join(', '))
  if (bb.riskProfiles.length) add('Risk profile', bb.riskProfiles.includes(d.riskProfile) ? 'pass' : 'fail', true, bb.riskProfiles.join(', '))
  if (bb.states.length || bb.markets.length) {
    const st = (d.state ?? '').toUpperCase()
    const mk = (d.market ?? '').toLowerCase()
    let status: CheckStatus
    if (!st && !mk) status = 'unknown'
    else {
      const stateHit = bb.states.length > 0 && st !== '' && bb.states.map(s => s.toUpperCase()).includes(st)
      const marketHit = bb.markets.length > 0 && mk !== '' && bb.markets.map(m => m.toLowerCase()).includes(mk)
      status = stateHit || marketHit ? 'pass' : 'fail'
    }
    add('Geography', status, true, [...bb.states, ...bb.markets].join(', '))
  }

  // ── soft criteria ──
  if (bb.minPrice != null || bb.maxPrice != null) add('Deal size', inRange(d.askPrice, bb.minPrice, bb.maxPrice), false, rangeLabel(bb.minPrice, bb.maxPrice, fmtM))
  if (bb.minGla != null || bb.maxGla != null) add('GLA', inRange(d.glaSf, bb.minGla, bb.maxGla), false, rangeLabel(bb.minGla, bb.maxGla, fmtSf))
  if (bb.minGoingInCap != null || bb.maxGoingInCap != null) add('Going-in cap', inRange(d.goingInCap, bb.minGoingInCap, bb.maxGoingInCap), false, rangeLabel(bb.minGoingInCap, bb.maxGoingInCap, fmtPct))
  if (bb.minIrr != null) add('Levered IRR', atLeast(d.projIrr, bb.minIrr), false, `≥ ${fmtPct(bb.minIrr)}`)
  if (bb.minEquityMultiple != null) add('Equity multiple', atLeast(d.equityMultiple, bb.minEquityMultiple), false, `≥ ${bb.minEquityMultiple.toFixed(2)}x`)

  const known = checks.filter(c => c.status !== 'unknown')
  const passed = known.filter(c => c.status === 'pass').length
  const disqualified = checks.some(c => c.hard && c.status === 'fail')
  const score = known.length > 0 ? passed / known.length : checks.length === 0 ? 1 : 0.5
  return { score, disqualified, checks, applicable: known.length, passed }
}

export interface BestFit { bb: BuyBox; fit: FitResult }
/** Best-matching ACTIVE buy-box for a deal — non-disqualified first, then by score. */
export function bestFit(d: FitDeal, buyBoxes: BuyBox[]): BestFit | null {
  const active = buyBoxes.filter(b => b.active)
  if (!active.length) return null
  const scored = active.map(bb => ({ bb, fit: scoreDealFit(d, bb) }))
  scored.sort((a, b) => (Number(a.fit.disqualified) - Number(b.fit.disqualified)) || (b.fit.score - a.fit.score))
  return scored[0]
}

export function fitCategory(best: BestFit | null): FitCategory {
  if (!best) return 'none'
  if (best.fit.disqualified) return 'off'
  if (best.fit.score >= 0.8) return 'on'
  if (best.fit.score >= 0.5) return 'partial'
  return 'off'
}

export const FIT_LABEL: Record<FitCategory, string> = { on: 'On-strategy', partial: 'Partial fit', off: 'Off-strategy', none: 'No buy-box' }
