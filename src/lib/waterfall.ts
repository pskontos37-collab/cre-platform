/**
 * Waterfall distribution engine.
 * Pure functions — no database calls, fully unit-testable.
 *
 * The production /waterfall path is computeSellToday(), which runs each
 * partner's dated cash flows through computeIrrWaterfall() (a true IRR-hurdle
 * solver) across two layers — see the section banner below for the math.
 */

import type { WaterfallTier, WaterfallTierType } from '../types/database'

// ============================================================================
// IRR-hurdle waterfall solver (dated cash flows)
// ----------------------------------------------------------------------------
// A TRUE IRR-hurdle solver: given each partner's dated cash-flow history plus a
// new distribution event, it finds the exact amount that carries the LP to each
// tier's hurdle IRR before the promote split steps up.
//
// Core trick: at a FIXED rate, XNPV is LINEAR in an added cash flow. So the LP
// cash needed to move its XIRR to exactly `rate` at a given date is closed-form
// (no nested root-finding):  D = -XNPV(rate, priorFlows) * (1+rate)^t.
// ============================================================================

export interface DatedFlow {
  date: string | Date   // ISO 'yyyy-mm-dd' or Date
  amount: number        // contributions negative, distributions positive
}

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000
const _t = (d: string | Date): number => (d instanceof Date ? d : new Date(d)).getTime()

/** Net present value of dated flows at annual `rate` (Actual/365), referenced to the earliest date. */
export function xnpv(rate: number, flows: DatedFlow[]): number {
  if (flows.length === 0) return 0
  const t0 = Math.min(...flows.map(f => _t(f.date)))
  return flows.reduce((s, f) => s + f.amount / Math.pow(1 + rate, (_t(f.date) - t0) / MS_PER_YEAR), 0)
}

/** Annualized IRR (Actual/365) for dated flows. Returns null if it cannot be bracketed. */
export function xirr(flows: DatedFlow[], guess = 0.1): number | null {
  if (!flows.some(f => f.amount > 0) || !flows.some(f => f.amount < 0)) return null
  // Newton-Raphson with a numeric derivative.
  let rate = guess
  for (let i = 0; i < 80; i++) {
    const f = xnpv(rate, flows)
    const d = (xnpv(rate + 1e-6, flows) - f) / 1e-6
    if (Math.abs(d) < 1e-12) break
    let next = rate - f / d
    if (!isFinite(next)) break
    if (next <= -0.999999) next = -0.999999 + 1e-7
    if (Math.abs(next - rate) < 1e-9) return next
    rate = next
  }
  // Bisection fallback across a wide bracket.
  let lo = -0.9999, hi = 100
  let flo = xnpv(lo, flows)
  if (flo * xnpv(hi, flows) > 0) return null
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2
    const fm = xnpv(mid, flows)
    if (Math.abs(fm) < 1e-8) return mid
    if (flo * fm < 0) hi = mid
    else { lo = mid; flo = fm }
  }
  return (lo + hi) / 2
}

/** LP cash at `date` needed to bring its XIRR up to exactly `rate`. <=0 means the LP is already at/above it. */
export function cashToHitIrr(lpFlows: DatedFlow[], rate: number, date: string | Date): number {
  if (lpFlows.length === 0) return 0
  const t0 = Math.min(...lpFlows.map(f => _t(f.date)), _t(date))
  const old = lpFlows.reduce((s, f) => s + f.amount / Math.pow(1 + rate, (_t(f.date) - t0) / MS_PER_YEAR), 0)
  const disc = Math.pow(1 + rate, (_t(date) - t0) / MS_PER_YEAR)
  return -old * disc
}

export interface IrrPosition {
  investorId: string
  type: 'lp' | 'gp'
  flows: DatedFlow[]    // full dated history (contributions negative, prior distributions positive)
}

export interface IrrPrefEquity {
  investorId: string
  principal: number
  rate: number          // annual
  sinceDate: string | Date
  compounding?: boolean // annual compounding of unpaid return (default false = simple)
  accruedReturn?: number
  isRedeemed?: boolean
}

/**
 * A senior unit class inside a syndication entity (e.g. Gateway's Class D):
 * takes 100% of all distributions ahead of every other class until it has
 * received the LESSER of `emCap` × contributed capital and an `irrCap` IRR.
 */
export interface SeniorClassPosition {
  investorId: string
  flows: DatedFlow[]      // contributions negative, prior distributions positive
  irrCap: number | null   // e.g. 0.15
  emCap: number | null    // e.g. 2.0
}

/** Cash owed to a senior class at `date` under its lesser-of cap. <=0 means fully satisfied. */
export function seniorClassOwed(pos: SeniorClassPosition, date: string | Date): number {
  const contrib = pos.flows.filter(f => f.amount < 0).reduce((a, f) => a - f.amount, 0)
  const prior = pos.flows.filter(f => f.amount > 0).reduce((a, f) => a + f.amount, 0)
  const byIrr = pos.irrCap != null ? cashToHitIrr(pos.flows, pos.irrCap, date) : Infinity
  const byEm = pos.emCap != null ? pos.emCap * contrib - prior : Infinity
  const owed = Math.min(byIrr, byEm)
  return isFinite(owed) ? Math.max(0, owed) : 0
}

export interface IrrWaterfallInput {
  cashAvailable: number
  distributionDate: string | Date
  positions: IrrPosition[]
  tiers: WaterfallTier[]
  preferredEquity?: IrrPrefEquity[]
  priorityCapital?: number  // outstanding priority/default-cure capital (drives ROC + preferred_return tiers); default 0
  /**
   * Hurdle-freeze date: IRR hurdles are solved (and this event's flows deemed made) as of this
   * date instead of distributionDate. Implements clauses like Knightdale's 6-4-25 amendment,
   * where the sale distribution "shall be deemed to have been made as of June 30, 2025".
   */
  hurdleDate?: string | Date
  /** Senior unit classes paid 100% ahead of the tier ladder (after preferred equity). */
  seniorClasses?: SeniorClassPosition[]
}

export interface IrrWaterfallLine {
  investorId: string
  investorType: 'lp' | 'gp' | 'preferred_equity' | 'senior_class'
  tierType: string
  tierOrder: number | null
  amount: number
  description: string
}

export interface IrrTierResult {
  tierOrder: number
  tierType: WaterfallTierType
  hurdleIrr: number | null
  hurdleEm: number | null
  emGoverned: boolean      // true when the EM cap (not the IRR hurdle) set this tier's size
  lpSplit: number
  gpSplit: number
  lp: number
  gp: number
  reachedHurdle: boolean   // true if this tier's hurdle was met (cash didn't run out inside it)
}

export interface IrrWaterfallResult {
  lineItems: IrrWaterfallLine[]
  totalDistributed: number
  residualCash: number
  lpTake: number
  gpTake: number
  prefTake: number
  seniorClassTake: number
  lpIrrAfter: number | null
  gpIrrAfter: number | null
  lpEmAfter: number | null   // (prior + this event's distributions) / contributed capital
  tierResults: IrrTierResult[]
}

/**
 * Solve one distribution event with true IRR hurdles.
 *
 * Order: (1) senior preferred equity (dated accrual + redemption); (2) senior unit classes
 * (lesser-of EM/IRR caps); (3) common tiers in tier_order. For each `promote_split` tier with a
 * hurdle, cash is split at the tier's LP/GP ratio until the LP's XIRR reaches the hurdle IRR or
 * the LP's cumulative distributions reach the EM cap — whichever is LESSER — then the next
 * tier's split applies. A `promote_split` with no hurdle takes all remaining cash at its split.
 *
 * `return_of_capital` returns unreturned LP capital (priority capital first, if any).
 * `preferred_return` pays the LP up to its `pref_rate` IRR but only against outstanding
 * priorityCapital (default 0 => no-op, since these deals' pref sits on contingent default-cure
 * capital). `gp_catchup` brings the GP up to its promote % of profit distributed so far.
 */
export function computeIrrWaterfall(input: IrrWaterfallInput): IrrWaterfallResult {
  const EPS = 1e-6
  // Deemed date for hurdle solves and this event's flows (freeze clause); defaults to the real date.
  const date = input.hurdleDate ?? input.distributionDate
  let remaining = input.cashAvailable
  const lines: IrrWaterfallLine[] = []
  const tierResults: IrrTierResult[] = []

  const lps = input.positions.filter(p => p.type === 'lp')
  const gps = input.positions.filter(p => p.type === 'gp')
  const lpFlows: DatedFlow[] = lps.flatMap(p => p.flows.map(f => ({ ...f })))
  const gpFlows: DatedFlow[] = gps.flatMap(p => p.flows.map(f => ({ ...f })))
  const sumNegAsPos = (fs: DatedFlow[]) => fs.filter(f => f.amount < 0).reduce((a, f) => a - f.amount, 0)
  const sumPos = (fs: DatedFlow[]) => fs.filter(f => f.amount > 0).reduce((a, f) => a + f.amount, 0)
  const lpContrib = sumNegAsPos(lpFlows)
  const lpPriorDist = sumPos(lpFlows)

  let lpTake = 0, gpTake = 0, prefTake = 0, seniorClassTake = 0
  let priorityCap = input.priorityCapital ?? 0

  const lpContribById = new Map(lps.map(p => [p.investorId, sumNegAsPos(p.flows)]))
  const totalLpContribForSplit = [...lpContribById.values()].reduce((a, b) => a + b, 0)

  function payLp(amt: number, tierType: string, tierOrder: number | null, desc: string) {
    if (amt <= EPS) return
    // Allocate across LPs pro-rata by contribution (equal if none contributed).
    for (const lp of lps) {
      const share = totalLpContribForSplit > 0 ? (lpContribById.get(lp.investorId)! / totalLpContribForSplit) : 1 / lps.length
      const a = amt * share
      if (a <= 0) continue
      lines.push({ investorId: lp.investorId, investorType: 'lp', tierType, tierOrder, amount: a, description: desc })
    }
    lpFlows.push({ date, amount: amt })
    lpTake += amt
    remaining -= amt
  }
  function payGp(amt: number, tierType: string, tierOrder: number | null, desc: string) {
    if (amt <= EPS || gps.length === 0) return
    lines.push({ investorId: gps[0].investorId, investorType: 'gp', tierType, tierOrder, amount: amt, description: desc })
    gpFlows.push({ date, amount: amt })
    gpTake += amt
    remaining -= amt
  }

  // ── Step 1: senior preferred equity (dated) ──
  for (const pe of input.preferredEquity ?? []) {
    if (pe.isRedeemed || remaining <= EPS) continue
    const yrs = Math.max(0, (_t(date) - _t(pe.sinceDate)) / MS_PER_YEAR)
    const gross = pe.compounding ? pe.principal * (Math.pow(1 + pe.rate, yrs) - 1) : pe.principal * pe.rate * yrs
    const owed = (pe.accruedReturn ?? 0) + gross
    const payRet = Math.min(owed, remaining)
    if (payRet > EPS) {
      lines.push({ investorId: pe.investorId, investorType: 'preferred_equity', tierType: 'preferred_equity_return', tierOrder: null, amount: payRet, description: `Pref equity return @ ${(pe.rate * 100).toFixed(2)}%` })
      remaining -= payRet; prefTake += payRet
    }
    if (payRet >= owed - EPS && remaining >= pe.principal - EPS) {
      lines.push({ investorId: pe.investorId, investorType: 'preferred_equity', tierType: 'preferred_equity_redemption', tierOrder: null, amount: pe.principal, description: 'Pref equity principal redemption' })
      remaining -= pe.principal; prefTake += pe.principal
    }
  }

  // ── Step 1b: senior unit classes — 100% priority until lesser-of cap satisfied ──
  for (const sc of input.seniorClasses ?? []) {
    if (remaining <= EPS) break
    const owed = seniorClassOwed(sc, date)
    const pay = Math.min(owed, remaining)
    if (pay > EPS) {
      const capDesc = [
        sc.emCap != null ? `${sc.emCap.toFixed(2)}x EM` : null,
        sc.irrCap != null ? `${(sc.irrCap * 100).toFixed(0)}% IRR` : null,
      ].filter(Boolean).join(' / ')
      lines.push({ investorId: sc.investorId, investorType: 'senior_class', tierType: 'senior_class_preference', tierOrder: null, amount: pay, description: `Senior class preference (lesser of ${capDesc})` })
      remaining -= pay; seniorClassTake += pay
    }
  }

  // ── Step 2: common-equity tiers in order ──
  const tiers = [...input.tiers].sort((a, b) => a.tier_order - b.tier_order)
  for (const t of tiers) {
    if (remaining <= EPS) break
    const lp = t.lp_split_pct ?? 0
    const gp = t.gp_split_pct ?? 0

    switch (t.tier_type) {
      case 'return_of_capital': {
        const pool = priorityCap > EPS ? priorityCap : Math.max(0, lpContrib - lpPriorDist - lpTake)
        const pay = Math.min(pool, remaining)
        payLp(pay, 'return_of_capital', t.tier_order, priorityCap > EPS ? 'Return of Priority Capital' : 'Return of LP capital')
        if (priorityCap > EPS) priorityCap -= pay
        break
      }
      case 'preferred_return': {
        if (!t.pref_rate || priorityCap <= EPS) break   // pref sits on contingent priority capital; no-op if none
        const need = cashToHitIrr(lpFlows, t.pref_rate, date)
        payLp(Math.min(Math.max(0, need), remaining), 'preferred_return', t.tier_order, `LP preferred return @ ${(t.pref_rate * 100).toFixed(2)}%`)
        break
      }
      case 'gp_catchup': {
        if (!gp || gps.length === 0) break
        const profit = lpTake + gpTake
        const gpTarget = profit * gp    // GP should hold gp% of profit distributed
        const pay = Math.min(Math.max(0, gpTarget - gpTake), remaining)
        payGp(pay, 'gp_catchup', t.tier_order, `GP catch-up to ${(gp * 100).toFixed(0)}%`)
        break
      }
      case 'promote_split': {
        let reached = true
        let emGoverned = false
        let lpPay: number, gpPay: number
        const hurdleEm = t.hurdle_em ?? null
        if (t.hurdle_irr != null || hurdleEm != null) {
          // Tier is satisfied at the LESSER of the IRR hurdle and the equity-multiple cap.
          const needIrr = t.hurdle_irr != null ? cashToHitIrr(lpFlows, t.hurdle_irr, date) : Infinity
          const needEm = hurdleEm != null ? hurdleEm * lpContrib - (lpPriorDist + lpTake) : Infinity
          const need = Math.min(needIrr, needEm)
          emGoverned = needEm < needIrr - EPS
          // LP already at/above this hurdle -> this tier is satisfied; move to the next (higher) tier.
          if (need <= EPS) { tierResults.push({ tierOrder: t.tier_order, tierType: t.tier_type, hurdleIrr: t.hurdle_irr, hurdleEm, emGoverned, lpSplit: lp, gpSplit: gp, lp: 0, gp: 0, reachedHurdle: true }); continue }
          const tierTotal = lp > 0 ? need / lp : remaining
          const actual = Math.min(tierTotal, remaining)
          reached = actual >= tierTotal - EPS
          lpPay = lp * actual; gpPay = gp * actual
        } else {
          lpPay = lp * remaining; gpPay = gp * remaining
        }
        const hurdleDesc = [
          t.hurdle_irr != null ? `${(t.hurdle_irr * 100).toFixed(0)}% IRR` : null,
          hurdleEm != null ? `${hurdleEm.toFixed(2)}x EM` : null,
        ].filter(Boolean).join(' / lesser of ')
        const desc = `${(lp * 100).toFixed(0)}/${(gp * 100).toFixed(0)} split` + (hurdleDesc ? ` to ${hurdleDesc}` : ' (residual)')
        payLp(lpPay, 'promote_split', t.tier_order, `LP ${desc}`)
        payGp(gpPay, 'promote_split', t.tier_order, `GP ${desc}`)
        tierResults.push({ tierOrder: t.tier_order, tierType: t.tier_type, hurdleIrr: t.hurdle_irr, hurdleEm, emGoverned, lpSplit: lp, gpSplit: gp, lp: lpPay, gp: gpPay, reachedHurdle: reached })
        break
      }
    }
  }

  return {
    lineItems: lines,
    totalDistributed: input.cashAvailable - remaining,
    residualCash: remaining,
    lpTake, gpTake, prefTake, seniorClassTake,
    lpIrrAfter: xirr(lpFlows),
    gpIrrAfter: xirr(gpFlows),
    lpEmAfter: lpContrib > 0 ? (lpPriorDist + lpTake) / lpContrib : null,
    tierResults,
  }
}

/**
 * Convenience runner: thread a chronological series of distribution events through
 * computeIrrWaterfall, carrying each partner's cash-flow history forward. Returns the
 * per-event results plus each partner's final XIRR and total distributions.
 */
export function runIrrWaterfall(opts: {
  positions: IrrPosition[]
  tiers: WaterfallTier[]
  events: { date: string | Date; amount: number }[]
  preferredEquity?: IrrPrefEquity[]
  priorityCapital?: number
}): {
  events: IrrWaterfallResult[]
  lpIrr: number | null
  gpIrr: number | null
  lpTotal: number
  gpTotal: number
  prefTotal: number
} {
  const positions = opts.positions.map(p => ({ ...p, flows: p.flows.map(f => ({ ...f })) }))
  const pref = (opts.preferredEquity ?? []).map(p => ({ ...p }))
  const results: IrrWaterfallResult[] = []
  let lpTotal = 0, gpTotal = 0, prefTotal = 0

  for (const ev of opts.events.slice().sort((a, b) => _t(a.date) - _t(b.date))) {
    const res = computeIrrWaterfall({
      cashAvailable: ev.amount, distributionDate: ev.date,
      positions, tiers: opts.tiers, preferredEquity: pref, priorityCapital: opts.priorityCapital,
    })
    results.push(res)
    lpTotal += res.lpTake; gpTotal += res.gpTake; prefTotal += res.prefTake
    // carry forward: append this event's realized distributions to each partner's history
    for (const li of res.lineItems) {
      const pos = positions.find(p => p.investorId === li.investorId)
      if (pos) pos.flows.push({ date: ev.date, amount: li.amount })
    }
    // mark pref equity redeemed / accrue carry-forward
    for (const li of res.lineItems) {
      if (li.investorType === 'preferred_equity' && li.tierType === 'preferred_equity_redemption') {
        const pe = pref.find(p => p.investorId === li.investorId); if (pe) pe.isRedeemed = true
      }
    }
  }

  const lpFlows = positions.filter(p => p.type === 'lp').flatMap(p => p.flows)
  const gpFlows = positions.filter(p => p.type === 'gp').flatMap(p => p.flows)
  return { events: results, lpIrr: xirr(lpFlows), gpIrr: xirr(gpFlows), lpTotal, gpTotal, prefTotal }
}

// ============================================================================
// "Sold today" solver
// ----------------------------------------------------------------------------
// Turns a hypothetical sale at an as-of date into net proceeds and runs them
// through BOTH waterfall layers on top of each partner's ACTUAL dated flow
// history:
//   proceeds = value × (1 − closing%) − debt/pref payoff (+ net current assets,
//   unless the JV agreement routes cash on hand around the waterfall, e.g.
//   Knightdale's 90/10 Net-Cash-Flow leg)
// Supports Knightdale's June-2025 amendment: sale-price override (proceeds
// above a threshold split at fixed percentages outside the IRR ladder,
// measured against price net of closing costs — the workbook convention) and
// the hurdle-freeze date. Layer 2 feeds the GP's total take plus entity cash
// through the syndication tiers (senior classes first) to value each unit
// class — the B-unit hypothetical liquidation value.
// ============================================================================

export interface SellTodayL1Config {
  positions: IrrPosition[]      // actual dated flows; hurdles are measured on the LP partner
  tiers: WaterfallTier[]
  freezeDate?: string | null    // e.g. '2025-06-30' for Knightdale
  saleOverride?: { threshold: number; lpShare: number; gpShare: number } | null
  cashSplit?: { lpShare: number; gpShare: number } | null   // NCA bypasses the ladder when set
}

export interface SellTodayL2Config {
  entityCash: number
  lpFlows: DatedFlow[]          // senior common (Class A, or A/C combined) actual flows
  gpFlows: DatedFlow[]          // Class B (promote units) flows
  seniorClasses?: SeniorClassPosition[]   // e.g. Gateway Class D
  tiers: WaterfallTier[]
}

export interface SellTodayInput {
  asOfDate: string | Date
  grossValue: number
  closingCostPct: number
  netCurrentAssets: number
  payoff: number                // mortgage or preferred-equity payoff
  l1: SellTodayL1Config
  l2?: SellTodayL2Config
}

export interface SellTodayResult {
  priceNetOfCosts: number
  overrideExcess: number
  overrideLp: number
  overrideGp: number
  cashLp: number
  cashGp: number
  ladderPool: number
  l1: IrrWaterfallResult
  l1LpTotal: number             // ladder + override + cash legs
  l1GpTotal: number
  l1LpContrib: number
  l1LpPriorDist: number
  l1LpIrr: number | null        // pro-forma XIRR incl. all legs (at the deemed date)
  l1GpIrr: number | null
  l1LpEm: number | null
  l2?: {
    pool: number                // GP total + entity cash
    result: IrrWaterfallResult
    classAValue: number
    classBValue: number
    seniorClassValues: Record<string, number>
  }
}

export function computeSellToday(input: SellTodayInput): SellTodayResult {
  const deemedDate = input.l1.freezeDate ?? input.asOfDate
  const priceNetOfCosts = input.grossValue * (1 - input.closingCostPct)

  // Sale-price override: excess above the threshold is carved out ahead of the
  // ladder and split at fixed shares; hurdle amounts ignore it (they are fixed
  // sums under the amendment).
  const ov = input.l1.saleOverride
  const overrideExcess = ov ? Math.max(0, priceNetOfCosts - ov.threshold) : 0
  const overrideLp = ov ? overrideExcess * ov.lpShare : 0
  const overrideGp = ov ? overrideExcess * ov.gpShare : 0

  // Net current assets: through the ladder by default; straight split when the
  // JV agreement routes cash on hand around the waterfall.
  const cs = input.l1.cashSplit
  const cashLp = cs ? input.netCurrentAssets * cs.lpShare : 0
  const cashGp = cs ? input.netCurrentAssets * cs.gpShare : 0
  const ncaIntoPool = cs ? 0 : input.netCurrentAssets

  const ladderPool = Math.max(0, priceNetOfCosts - input.payoff - overrideExcess + ncaIntoPool)

  const l1 = computeIrrWaterfall({
    cashAvailable: ladderPool,
    distributionDate: input.asOfDate,
    hurdleDate: input.l1.freezeDate ?? undefined,
    positions: input.l1.positions,
    tiers: input.l1.tiers,
  })

  const lpHist = input.l1.positions.filter(p => p.type === 'lp').flatMap(p => p.flows)
  const gpHist = input.l1.positions.filter(p => p.type === 'gp').flatMap(p => p.flows)
  const l1LpContrib = lpHist.filter(f => f.amount < 0).reduce((a, f) => a - f.amount, 0)
  const l1LpPriorDist = lpHist.filter(f => f.amount > 0).reduce((a, f) => a + f.amount, 0)
  const l1LpTotal = l1.lpTake + overrideLp + cashLp
  const l1GpTotal = l1.gpTake + overrideGp + cashGp
  const l1LpIrr = l1LpTotal > 0 || lpHist.length > 0
    ? xirr([...lpHist, { date: deemedDate, amount: l1LpTotal }])
    : null
  const l1GpIrr = gpHist.length > 0 && (l1GpTotal > 0 || gpHist.some(f => f.amount !== 0))
    ? xirr([...gpHist, { date: deemedDate, amount: l1GpTotal }])
    : null
  const l1LpEm = l1LpContrib > 0 ? (l1LpPriorDist + l1LpTotal) / l1LpContrib : null

  let l2: SellTodayResult['l2']
  if (input.l2) {
    const pool = l1GpTotal + input.l2.entityCash
    const result = computeIrrWaterfall({
      cashAvailable: pool,
      distributionDate: input.asOfDate,
      positions: [
        { investorId: 'senior_common', type: 'lp', flows: input.l2.lpFlows },
        { investorId: 'class_b', type: 'gp', flows: input.l2.gpFlows },
      ],
      tiers: input.l2.tiers,
      seniorClasses: input.l2.seniorClasses,
    })
    const seniorClassValues: Record<string, number> = {}
    for (const li of result.lineItems) {
      if (li.investorType === 'senior_class') {
        seniorClassValues[li.investorId] = (seniorClassValues[li.investorId] ?? 0) + li.amount
      }
    }
    l2 = { pool, result, classAValue: result.lpTake, classBValue: result.gpTake, seniorClassValues }
  }

  return {
    priceNetOfCosts, overrideExcess, overrideLp, overrideGp, cashLp, cashGp, ladderPool,
    l1, l1LpTotal, l1GpTotal, l1LpContrib, l1LpPriorDist, l1LpIrr, l1GpIrr, l1LpEm, l2,
  }
}
