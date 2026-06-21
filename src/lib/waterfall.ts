/**
 * Waterfall distribution engine.
 * Pure functions — no database calls, fully unit-testable.
 *
 * Payment order:
 *  1. Preferred equity (return + principal redemption) — senior to common equity
 *  2. Walk waterfall_tiers in tier_order ascending:
 *     a. return_of_capital  — LP gets capital back pro-rata
 *     b. preferred_return   — LP accrued pref is paid
 *     c. gp_catchup         — GP catches up to its promote %
 *     d. promote_split      — remaining cash splits LP/GP per tier
 */

import type { WaterfallTier } from '../types/database'

export interface CapitalPosition {
  investorId: string
  type: 'lp' | 'gp'
  initialContribution: number
  contributedToDate: number
  distributedToDate: number
  prefAccruedToDate: number
}

export interface PrefEquityPosition {
  investorId: string
  principal: number
  preferredRate: number   // annual, e.g. 0.10 = 10%
  isPik: boolean
  accruedReturn: number
  isRedeemed: boolean
}

export interface WaterfallInput {
  cashAvailable: number
  positions: CapitalPosition[]
  preferredEquityPositions: PrefEquityPosition[]
  tiers: WaterfallTier[]
  periodYears: number     // e.g. 1 = annual, 0.25 = quarterly
}

export interface WaterfallLineItem {
  investorId: string
  investorType: 'lp' | 'gp' | 'preferred_equity'
  tierType: string
  tierOrder: number | null
  amount: number
  description: string
}

export interface WaterfallResult {
  lineItems: WaterfallLineItem[]
  totalDistributed: number
  residualCash: number
  updatedPositions: CapitalPosition[]
  updatedPrefEquityPositions: PrefEquityPosition[]
}

/**
 * Accrue preferred return on a capital position for one period.
 * Cumulative: pref accrues on unreturned capital.
 * Non-cumulative (simple): pref accrues on initial contribution only.
 */
export function accruePreferredReturn(
  position: CapitalPosition,
  annualRate: number,
  periodYears: number,
  isCumulative: boolean,
): number {
  const base = isCumulative
    ? Math.max(0, position.initialContribution - position.distributedToDate)
    : position.initialContribution
  return base * annualRate * periodYears
}

export function computeWaterfall(input: WaterfallInput): WaterfallResult {
  let remaining = input.cashAvailable
  const lineItems: WaterfallLineItem[] = []

  const positions = input.positions.map(p => ({ ...p }))
  const prefEquityPositions = input.preferredEquityPositions.map(p => ({ ...p }))

  // ── Step 1: Preferred equity (senior to common equity) ─────────────────
  for (const pref of prefEquityPositions) {
    if (pref.isRedeemed || remaining <= 0) continue

    const periodAccrual = pref.principal * pref.preferredRate * input.periodYears

    if (pref.isPik) {
      // PIK: accrues to balance, not paid in cash this period
      pref.accruedReturn += periodAccrual
    } else {
      const totalOwed = pref.accruedReturn + periodAccrual
      const payment = Math.min(totalOwed, remaining)
      if (payment > 0) {
        lineItems.push({
          investorId: pref.investorId,
          investorType: 'preferred_equity',
          tierType: 'preferred_equity_return',
          tierOrder: null,
          amount: payment,
          description: `Pref equity return @ ${(pref.preferredRate * 100).toFixed(2)}%`,
        })
        pref.accruedReturn = totalOwed - payment
        remaining -= payment
      }
    }

    // Redeem principal once return is current and cash allows
    if (!pref.isRedeemed && pref.accruedReturn === 0 && remaining >= pref.principal) {
      lineItems.push({
        investorId: pref.investorId,
        investorType: 'preferred_equity',
        tierType: 'preferred_equity_redemption',
        tierOrder: null,
        amount: pref.principal,
        description: 'Pref equity principal redemption',
      })
      remaining -= pref.principal
      pref.isRedeemed = true
    }
  }

  // ── Step 2: Common equity waterfall tiers ──────────────────────────────
  const sortedTiers = [...input.tiers].sort((a, b) => a.tier_order - b.tier_order)

  for (const tier of sortedTiers) {
    if (remaining <= 0) break

    const lpPositions = positions.filter(p => p.type === 'lp')
    const gpPositions = positions.filter(p => p.type === 'gp')

    switch (tier.tier_type) {
      case 'return_of_capital': {
        const totalLpContrib = lpPositions.reduce((s, p) => s + p.initialContribution, 0)
        for (const lp of lpPositions) {
          if (remaining <= 0) break
          const unreturned = lp.initialContribution - lp.distributedToDate
          if (unreturned <= 0) continue
          const pay = Math.min(unreturned, remaining)
          lineItems.push({
            investorId: lp.investorId,
            investorType: 'lp',
            tierType: 'return_of_capital',
            tierOrder: tier.tier_order,
            amount: pay,
            description: `Return of LP capital`,
          })
          lp.distributedToDate += pay
          remaining -= pay
          void totalLpContrib
        }
        break
      }

      case 'preferred_return': {
        if (!tier.pref_rate) break
        // First accrue this period's pref for all LPs
        for (const lp of lpPositions) {
          lp.prefAccruedToDate += accruePreferredReturn(lp, tier.pref_rate, input.periodYears, tier.is_cumulative)
        }
        const totalPrefOwed = lpPositions.reduce((s, p) => s + p.prefAccruedToDate, 0)
        if (totalPrefOwed <= 0) break
        // Pay pro-rata by accrued amount
        for (const lp of lpPositions) {
          if (remaining <= 0) break
          if (lp.prefAccruedToDate <= 0) continue
          const share = lp.prefAccruedToDate / totalPrefOwed
          const pay = Math.min(lp.prefAccruedToDate, remaining * share)
          lineItems.push({
            investorId: lp.investorId,
            investorType: 'lp',
            tierType: 'preferred_return',
            tierOrder: tier.tier_order,
            amount: pay,
            description: `LP preferred return @ ${(tier.pref_rate * 100).toFixed(2)}%`,
          })
          lp.prefAccruedToDate -= pay
          lp.distributedToDate += pay
          remaining -= pay
        }
        break
      }

      case 'gp_catchup': {
        if (!tier.gp_split_pct || gpPositions.length === 0) break
        const totalToLp = lpPositions.reduce((s, p) => s + p.distributedToDate, 0)
        const totalToGp = gpPositions.reduce((s, p) => s + p.distributedToDate, 0)
        const totalDistributed = totalToLp + totalToGp
        const gpTarget = totalDistributed * tier.gp_split_pct
        const catchupNeeded = Math.max(0, gpTarget - totalToGp)
        const pay = Math.min(catchupNeeded, remaining)
        if (pay > 0) {
          const gp = gpPositions[0]
          lineItems.push({
            investorId: gp.investorId,
            investorType: 'gp',
            tierType: 'gp_catchup',
            tierOrder: tier.tier_order,
            amount: pay,
            description: `GP catch-up to ${(tier.gp_split_pct * 100).toFixed(0)}%`,
          })
          gp.distributedToDate += pay
          remaining -= pay
        }
        break
      }

      case 'promote_split': {
        if (!tier.lp_split_pct || !tier.gp_split_pct) break
        const lpAmount = remaining * tier.lp_split_pct
        const gpAmount = remaining * tier.gp_split_pct

        if (lpAmount > 0 && lpPositions.length > 0) {
          const totalLpContrib = lpPositions.reduce((s, p) => s + p.initialContribution, 0)
          for (const lp of lpPositions) {
            const share = totalLpContrib > 0 ? lp.initialContribution / totalLpContrib : 1 / lpPositions.length
            const pay = lpAmount * share
            lineItems.push({
              investorId: lp.investorId,
              investorType: 'lp',
              tierType: 'promote_split',
              tierOrder: tier.tier_order,
              amount: pay,
              description: `LP ${(tier.lp_split_pct * 100).toFixed(0)}/${(tier.gp_split_pct * 100).toFixed(0)} promote split`,
            })
            lp.distributedToDate += pay
          }
        }

        if (gpAmount > 0 && gpPositions.length > 0) {
          const gp = gpPositions[0]
          lineItems.push({
            investorId: gp.investorId,
            investorType: 'gp',
            tierType: 'promote_split',
            tierOrder: tier.tier_order,
            amount: gpAmount,
            description: `GP ${(tier.gp_split_pct * 100).toFixed(0)}% promote`,
          })
          gp.distributedToDate += gpAmount
        }

        remaining = 0
        break
      }
    }
  }

  return {
    lineItems,
    totalDistributed: input.cashAvailable - remaining,
    residualCash: remaining,
    updatedPositions: positions,
    updatedPrefEquityPositions: prefEquityPositions,
  }
}
