import { useMemo } from 'react'
import { xirr, type DatedFlow } from '../lib/waterfall'
import { sellTodayFull, flowsByRoles, todayIso } from '../lib/sellTodayForDeal'
import { useGlNcaMap } from './useWaterfallDefaults'
import type { DealRow } from './useDeals'

const ROLE_NAMES: Record<string, string> = {
  'lp': 'LP Partner',
  'gp': 'GP (MJW Wilkow)',
  'class_a': 'Class A',
  'class_ac': 'Class A/C',
  'class_b': 'Class B (Promote)',
  'class_c': 'Class C',
  'class_d': 'Class D (Senior)',
}

// ── Per-property breakdown (LP + GP), layer 1 ────────────────────────────────

export type Level = 'lp' | 'gp'

export interface RoleReturn {
  role: Level
  name: string
  contributed: number
  distributed: number
  currentEquity: number | null      // current sold-today take (unrealized value)
  realizedMultiple: number | null   // distributions ÷ contributions
  totalValueMultiple: number | null // (distributions + current equity) ÷ contributions
  totalValueIrr: number | null      // XIRR incl. current equity as a terminal inflow
}

export interface PropertyReturn {
  propertyId: string
  name: string
  assetType: string | null
  lp: RoleReturn | null
  gp: RoleReturn | null
}

export interface PortfolioReturnsByProperty {
  properties: PropertyReturn[]
  /** Pooled across every valued layer-1 property in scope, per role. */
  totals: Record<Level, RoleReturn>
  /** Distinct asset types present in scope (for the asset-class filter). */
  assetTypes: string[]
}

const emptyRole = (role: Level): RoleReturn => ({
  role,
  name: ROLE_NAMES[role],
  contributed: 0,
  distributed: 0,
  currentEquity: null,
  realizedMultiple: null,
  totalValueMultiple: null,
  totalValueIrr: null,
})

/**
 * Investor returns broken out per property (LP and GP side by side), with a
 * pooled portfolio total per role. Each position's current "sold-today" value
 * (from the waterfall engine, on live GL net-current-assets where available) is
 * credited as a terminal inflow, so the multiple and IRR reflect realized
 * distributions + unrealized value — the standard basis for an IRR on a
 * position not yet sold.
 *
 * LP = the Layer-1 institutional partner's flows vs. its L1 sold-today take.
 * GP = the JV's GP member, i.e. the Layer-2 M&J entity blended: all its class
 * flows (A/AC/C co-invest ≈ the ~10% GP position, D senior, nominal B) vs. the
 * entity's whole sold-today pool (L1 GP take + entity cash). The promote-only
 * (Class B) slice has no real capital basis — see /waterfall for that cascade.
 */
export function usePortfolioReturnsByProperty(
  deals: DealRow[] | null,
): PortfolioReturnsByProperty {
  const l1PropIds = useMemo(
    () => Array.from(new Set((deals ?? []).filter(d => d.layer === 1).map(d => d.property_id))),
    [deals],
  )
  const { data: ncaMap } = useGlNcaMap(l1PropIds)

  return useMemo(() => {
    const empty: PortfolioReturnsByProperty = {
      properties: [],
      totals: { lp: emptyRole('lp'), gp: emptyRole('gp') },
      assetTypes: [],
    }
    if (!deals || deals.length === 0) return empty

    // One layer-1 deal per property (the JV that carries LP/GP flows), paired
    // with its layer-2 syndication entity (M&J) where one exists.
    const l1 = deals.filter(d => d.layer === 1 && d.capital_flows.some(f => f.role === 'lp'))
    if (l1.length === 0) return empty
    const l2ByProp = new Map<string, DealRow>()
    for (const d of deals) if (d.layer === 2) l2ByProp.set(d.property_id, d)

    const asOf = todayIso()

    // Pooled flows for the portfolio-total XIRR, per role.
    const pooled: Record<Level, DatedFlow[]> = { lp: [], gp: [] }
    const totalAgg: Record<Level, { contributed: number; distributed: number; equity: number; valued: boolean }> = {
      lp: { contributed: 0, distributed: 0, equity: 0, valued: false },
      gp: { contributed: 0, distributed: 0, equity: 0, valued: false },
    }

    // Build one role's return from its dated flows + a sold-today terminal take,
    // and roll it into the portfolio pool. `take` null = no current valuation.
    const compute = (
      role: Level,
      flows: DatedFlow[],
      take: number | null,
      takeDate: string,
    ): RoleReturn | null => {
      if (flows.length === 0 && take == null) return null
      let contributed = 0
      let distributed = 0
      for (const f of flows) {
        if (f.amount < 0) contributed -= f.amount
        else distributed += f.amount
      }
      const realizedMultiple = contributed > 0 ? distributed / contributed : null
      const hasValue = take != null
      const totalValueMultiple = contributed > 0 && hasValue ? (distributed + take!) / contributed : null
      const totalValueIrr = hasValue
        ? xirr([...flows, { date: takeDate, amount: take! }])
        : (contributed > 0 && distributed > 0 ? xirr(flows) : null)

      const agg = totalAgg[role]
      agg.contributed += contributed
      agg.distributed += distributed
      pooled[role].push(...flows)
      if (hasValue) {
        agg.equity += take!
        agg.valued = true
        pooled[role].push({ date: takeDate, amount: take! })
      }

      return {
        role,
        name: ROLE_NAMES[role],
        contributed,
        distributed,
        currentEquity: hasValue ? take! : null,
        realizedMultiple,
        totalValueMultiple,
        totalValueIrr,
      }
    }

    const properties: PropertyReturn[] = []
    for (const deal of l1) {
      const l2Deal = l2ByProp.get(deal.property_id) ?? null
      const st = sellTodayFull(deal, l2Deal, asOf, ncaMap?.[deal.property_id])
      const deemed = deal.selltoday?.freeze_date ?? asOf

      // LP: the Layer-1 institutional partner (take dated at the deal's freeze date).
      const lp = compute('lp', flowsByRoles(deal, ['lp']), st ? st.l1LpTotal : null, deemed)

      // GP: the JV's GP member IS the Layer-2 M&J entity — its classes' dated
      // capital (Class A/AC/C co-invest, Class D senior, nominal Class B) is the
      // ~10% GP position. Blend the entity: all L2 flows as the basis, terminal
      // inflow = the entity's whole sold-today pool (L1 GP take + entity cash).
      // Falls back to raw L1 gp flows where no L2 entity is modeled.
      const gpFlows = l2Deal
        ? flowsByRoles(l2Deal, ['class_a', 'class_ac', 'class_b', 'class_c', 'class_d'])
        : flowsByRoles(deal, ['gp'])
      const gpTake = st ? (st.l2 ? st.l2.pool : st.l1GpTotal) : null
      const gp = compute('gp', gpFlows, gpTake, deemed)

      properties.push({
        propertyId: deal.property_id,
        name: deal.properties?.name ?? deal.name,
        assetType: deal.properties?.asset_type ?? null,
        lp,
        gp,
      })
    }
    properties.sort((a, b) => a.name.localeCompare(b.name))

    const mkTotal = (role: Level): RoleReturn => {
      const agg = totalAgg[role]
      return {
        role,
        name: ROLE_NAMES[role],
        contributed: agg.contributed,
        distributed: agg.distributed,
        currentEquity: agg.valued ? agg.equity : null,
        realizedMultiple: agg.contributed > 0 ? agg.distributed / agg.contributed : null,
        totalValueMultiple: agg.contributed > 0 && agg.valued
          ? (agg.distributed + agg.equity) / agg.contributed : null,
        // XIRR needs a sign-changing stream (contributions + at least one inflow).
        totalValueIrr: pooled[role].some(f => f.amount < 0) && pooled[role].some(f => f.amount > 0)
          ? xirr(pooled[role]) : null,
      }
    }

    const assetTypes = Array.from(
      new Set(properties.map(p => p.assetType).filter((t): t is string => !!t)),
    ).sort()

    return {
      properties,
      totals: { lp: mkTotal('lp'), gp: mkTotal('gp') },
      assetTypes,
    }
  }, [deals, ncaMap])
}
