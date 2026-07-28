import { useQuery } from './useQuery'
import { supabase } from '../lib/supabase'

// Leasing-comps lookup (schema `comps`, migrations 20240137/39/40/41).
//
// Mined from the acquisition corpus at K:\ASSTMGMT\ACQUISITIONS: 1,013 property
// folders, 804 Argus-Assumptions tabs, 36,367 extracted cells. INTERNAL ONLY --
// this material comes from OMs and diligence files received under confidentiality
// agreements, so it must not be surfaced in LP-facing output (IC memo /
// Investment Summary). Read-only here by design.
//
// `comps` is NOT the default PostgREST schema, so every call goes through
// .schema('comps'). It also has to be in the project's Exposed schemas list.
//
// The aggregation lives in SQL rather than here on purpose: an "all markets"
// answer has to be a percentile over the raw rows, and combining per-market
// medians in the client would give a median of medians, which is not a median.

export interface CompsRollupRow {
  metric: string
  metricLabel: string
  unit: string | null
  n: number
  nProperties: number
  p25: number | null
  median: number | null
  p75: number | null
  minValue: number | null
  maxValue: number | null
  earliest: string | null
  latest: string | null
}

export interface CompsTenantRow {
  tenant: string
  tenantId: string | null
  obs: number
  medRentPsf: number | null
  nProperties: number
  nMarkets: number
  earliest: string | null
  latest: string | null
  inTenantMaster: boolean
}

export interface CompsMarket {
  market: string
  nProperties: number
  nCells: number
  earliest: string | null
  latest: string | null
  // Markets covering the same geography, because the K: tree keeps a metro folder next
  // to its state folder: Chicago/Illinois, Atlanta/Georgia, Boston/Massachusetts,
  // DC/Maryland, DC/Virginia. Expansion is OPT-IN -- a metro and its state are not the
  // same rent market, so we surface the choice rather than silently merging.
  relatedMarkets: string[]
}

export type CompsScope = 'space_category' | 'tenant' | 'floor_area' | 'suite' | 'lease_term'
export type CompsTier = 'internal' | 'broker' | 'all'

export const COMPS_SCOPE_LABEL: Record<CompsScope, string> = {
  space_category: 'Space category',
  tenant: 'Named tenant',
  floor_area: 'Floor / size',
  suite: 'Suite',
  lease_term: 'Lease term',
}

// How a value should read. The unit is carried per ROW, not per metric, because
// leasing commissions genuinely arrive as both a percent of rent and dollars PSF
// -- the two must never be averaged together, so they render as separate lines.
export function formatCompsValue(v: number | null, unit: string | null): string {
  if (v == null) return '--'
  const r = (n: number, d = 2) => Number(n.toFixed(d)).toString()
  switch (unit) {
    case 'pct':
    case 'pct_of_rent': return r(v, 1) + '%'
    case 'usd_psf':     return '$' + r(v)
    case 'months':      return r(v, 0) + ' mo'
    case 'years':       return r(v, 1) + ' yr'
    default:            return r(v)
  }
}

export const COMPS_UNIT_NOTE: Record<string, string> = {
  pct_of_rent: 'percent of rent',
  usd_psf: 'dollars per SF',
  months: 'months',
  pct: 'percent',
}

// The corpus is filed by K:\ state/market folder: mostly US state names, plus a
// handful of metros (Atlanta, Boston, Chicago, DC). A deal carries a 2-letter
// state and a metro market, so try the metro first, then the state name.
const STATE_NAME: Record<string, string> = {
  AL: 'Alabama', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Deleware', DC: 'DC', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island', SC: 'South Carolina',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin',
}
const MARKET_ALIAS: Record<string, string> = {
  'washington dc': 'DC',
  'chicago': 'Chicago',
  'atlanta': 'Atlanta',
  'boston': 'Boston',
}

/**
 * Best-guess comps market for a deal. Returns null when nothing matches, which
 * the panel renders as "All markets" rather than silently showing the wrong one.
 */
export function resolveCompsMarket(
  dealMarket: string | null, dealState: string | null, available: string[],
): string | null {
  const have = new Map(available.map(m => [m.toLowerCase(), m]))
  const metro = (dealMarket ?? '').trim().toLowerCase()
  if (metro) {
    const alias = MARKET_ALIAS[metro]
    if (alias && have.has(alias.toLowerCase())) return have.get(alias.toLowerCase()) as string
    if (have.has(metro)) return have.get(metro) as string
  }
  const st = (dealState ?? '').trim().toUpperCase()
  const name = STATE_NAME[st]
  if (name && have.has(name.toLowerCase())) return have.get(name.toLowerCase()) as string
  return null
}

const num = (v: unknown): number => (v == null ? 0 : Number(v))
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v))

export function useCompsMarkets() {
  return useQuery<CompsMarket[]>(async () => {
    const { data, error } = await supabase.schema('comps')
      .from('v_market_coverage')
      .select('market, n_properties, n_cells, earliest, latest, related_markets')
      .order('market')
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(r => ({
      market: r.market, nProperties: num(r.n_properties), nCells: num(r.n_cells),
      earliest: r.earliest ?? null, latest: r.latest ?? null,
      relatedMarkets: (r.related_markets ?? []) as string[],
    }))
  }, [])
}

export function useCompsRollup(
  market: string | null, scope: CompsScope, tier: CompsTier, tenant: string | null,
  includeRelated: boolean, enabled: boolean,
) {
  return useQuery<CompsRollupRow[]>(async () => {
    if (!enabled) return []
    const { data, error } = await supabase.schema('comps').rpc('lookup_assumptions', {
      p_market: market,
      p_scope: tenant ? 'tenant' : scope,
      p_tier: tier === 'all' ? null : tier,
      p_asset: null,
      p_tenant: tenant,
      p_include_related: includeRelated,
    })
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(r => ({
      metric: r.metric, metricLabel: r.metric_label, unit: r.unit ?? null,
      n: num(r.n), nProperties: num(r.n_properties),
      p25: numOrNull(r.p25), median: numOrNull(r.median), p75: numOrNull(r.p75),
      minValue: numOrNull(r.min_value), maxValue: numOrNull(r.max_value),
      earliest: r.earliest ?? null, latest: r.latest ?? null,
    }))
  }, [market, scope, tier, tenant, includeRelated, enabled])
}

export function useCompsTenants(
  query: string, market: string | null, includeRelated: boolean, enabled: boolean,
) {
  return useQuery<CompsTenantRow[]>(async () => {
    if (!enabled) return []
    const { data, error } = await supabase.schema('comps').rpc('lookup_tenants', {
      p_query: query || null, p_market: market, p_limit: 40,
      p_include_related: includeRelated,
    })
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).map(r => ({
      tenant: r.tenant, tenantId: r.tenant_id ?? null,
      obs: num(r.obs), medRentPsf: numOrNull(r.med_rent_psf),
      nProperties: num(r.n_properties), nMarkets: num(r.n_markets),
      earliest: r.earliest ?? null, latest: r.latest ?? null,
      inTenantMaster: Boolean(r.in_tenant_master),
    }))
  }, [query, market, includeRelated, enabled])
}
