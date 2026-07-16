import { xirr } from './waterfall'
import type { DealRow, CapitalFlowRow } from '../hooks/useDeals'

// Distribution-ledger math shared by the /investors page and the quarterly
// investor report PDF. Everything derives from capital_flows: negative
// amounts are capital in (contributions, and occasional clawbacks like the
// Oct/Nov 2025 Knightdale call-backs), positive amounts are cash distributed.

export interface PartyLedger {
  party: string
  role: string
  contributed: number          // total capital in (absolute)
  distributed: number          // total cash out to the partner
  dpi: number | null           // distributed / contributed
  irr: number | null           // realized IRR over actual dated flows (no residual value)
  lastDistribution: string | null
  flows: CapitalFlowRow[]      // ascending by date
}

export function buildPartyLedgers(deal: DealRow): PartyLedger[] {
  const byParty = new Map<string, CapitalFlowRow[]>()
  for (const f of deal.capital_flows) {
    const key = `${f.party}|${f.role}`
    const arr = byParty.get(key) ?? []
    arr.push(f)
    byParty.set(key, arr)
  }
  return [...byParty.values()]
    .map(flows => {
      const sorted = [...flows].sort((a, b) => a.flow_date.localeCompare(b.flow_date))
      const contributed = sorted.filter(f => Number(f.amount) < 0).reduce((s, f) => s - Number(f.amount), 0)
      const distributed = sorted.filter(f => Number(f.amount) > 0).reduce((s, f) => s + Number(f.amount), 0)
      const lastDistribution = [...sorted].reverse().find(f => Number(f.amount) > 0)?.flow_date ?? null
      // Realized IRR only once there is at least one round trip to measure.
      let irr: number | null = null
      if (contributed > 0 && distributed > 0) {
        irr = xirr(sorted.map(f => ({ date: f.flow_date, amount: Number(f.amount) })))
      }
      return {
        party: sorted[0].party,
        role: sorted[0].role,
        contributed,
        distributed,
        dpi: contributed > 0 ? distributed / contributed : null,
        irr,
        lastDistribution,
        flows: sorted,
      }
    })
    .sort((a, b) => b.contributed - a.contributed)
}

// ── quarters ────────────────────────────────────────────────────────────────

export interface QuarterRef {
  key: string        // '2026-Q2'
  label: string      // 'Q2 2026'
  year: number
  quarter: number    // 1-4
  months: number[]   // [4,5,6]
  start: string      // '2026-04-01'
  end: string        // '2026-06-30'
}

export function quarterRef(year: number, quarter: number): QuarterRef {
  const m0 = (quarter - 1) * 3 + 1
  const months = [m0, m0 + 1, m0 + 2]
  const endDay = new Date(year, m0 + 2, 0).getDate()   // last day of 3rd month
  const p = (n: number) => String(n).padStart(2, '0')
  return {
    key: `${year}-Q${quarter}`,
    label: `Q${quarter} ${year}`,
    year,
    quarter,
    months,
    start: `${year}-${p(m0)}-01`,
    end: `${year}-${p(m0 + 2)}-${p(endDay)}`,
  }
}

/** The last `n` COMPLETE quarters, most recent first. */
export function recentCompleteQuarters(n: number, today = new Date()): QuarterRef[] {
  let year = today.getFullYear()
  let quarter = Math.floor(today.getMonth() / 3)   // 0 => Q4 of prior year
  if (quarter === 0) { year -= 1; quarter = 4 }
  const out: QuarterRef[] = []
  for (let i = 0; i < n; i++) {
    out.push(quarterRef(year, quarter))
    quarter -= 1
    if (quarter === 0) { year -= 1; quarter = 4 }
  }
  return out
}

/** Net cash to the partner per quarter (all flows), over a continuous window
 *  of the last `lastN` quarters ending at the current one. */
export interface QuarterNet { ref: QuarterRef; net: number; hasFlows: boolean }

export function quarterlyNet(flows: CapitalFlowRow[], lastN = 8, today = new Date()): QuarterNet[] {
  const byKey = new Map<string, number>()
  for (const f of flows) {
    const y = Number(f.flow_date.slice(0, 4))
    const q = Math.floor((Number(f.flow_date.slice(5, 7)) - 1) / 3) + 1
    const key = `${y}-Q${q}`
    byKey.set(key, (byKey.get(key) ?? 0) + Number(f.amount))
  }
  // window ends at the CURRENT (possibly incomplete) quarter
  let year = today.getFullYear()
  let quarter = Math.floor(today.getMonth() / 3) + 1
  const out: QuarterNet[] = []
  for (let i = 0; i < lastN; i++) {
    const ref = quarterRef(year, quarter)
    out.unshift({ ref, net: byKey.get(ref.key) ?? 0, hasFlows: byKey.has(ref.key) })
    quarter -= 1
    if (quarter === 0) { year -= 1; quarter = 4 }
  }
  return out
}

/** Cash distributed to a party within [start, end] (positive flows only). */
export function distributedInWindow(flows: CapitalFlowRow[], start: string, end: string): number {
  return flows
    .filter(f => Number(f.amount) > 0 && f.flow_date >= start && f.flow_date <= end)
    .reduce((s, f) => s + Number(f.amount), 0)
}
