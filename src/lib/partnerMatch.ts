// partnerMatch.ts — score how well a deal fits a capital partner's mandate, to
// suggest the right LPs for a raise (Phase 4). The partner book stores product
// types structurally but deal-size / return / markets as FREE TEXT, so those are
// parsed best-effort: an unparseable field scores 'na' (never a false miss). Pure.

import type { AssetType } from '../hooks/usePipeline'

export interface MatchPartner {
  id: string
  name: string
  tier: 'current' | 'tier1_prospect' | 'tier2_prospect'
  productTypes: string[]
  markets: string | null
  returnTarget: string | null
  dealSize: string | null
  active: boolean
}
export interface MatchDeal {
  assetType: AssetType
  state: string | null
  market: string | null
  submarket: string | null
  askPrice: number | null
  projIrr: number | null
}

export type SignalStatus = 'hit' | 'miss' | 'na'
export interface MatchSignal { label: string; status: SignalStatus; detail?: string }
export interface PartnerMatch { partner: MatchPartner; score: number; signals: MatchSignal[] }

const US_STATES: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut',
  DE: 'delaware', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa',
  KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan',
  MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire',
  NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio',
  OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota',
  TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia',
  WI: 'wisconsin', WY: 'wyoming',
}

/** Parse the first "$X–Y (M/B/K)" range from free text into [min,max] dollars, or null. */
export function parseMoneyRange(text: string | null): [number, number] | null {
  if (!text) return null
  const m = text.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:mm|m|b|k)?\s*(?:-|–|to)\s*\$?\s*(\d+(?:\.\d+)?)\s*(mm|m|b|k)?/i)
  if (!m) {
    const single = text.match(/\$\s*(\d+(?:\.\d+)?)\s*(mm|m|b|k)?/i)
    if (!single) return null
    const v = Number(single[1]) * mult(single[2])
    return [v, v]
  }
  const unit = mult(m[3])
  return [Number(m[1]) * unit, Number(m[2]) * unit]
}
const mult = (u?: string): number => {
  const s = (u ?? 'm').toLowerCase()
  return s === 'b' ? 1e9 : s === 'k' ? 1e3 : 1e6 // default M (real-estate deal sizes are in millions)
}
/** Parse the first percentage in free text into a decimal, or null. */
export function parsePct(text: string | null): number | null {
  if (!text) return null
  const m = text.match(/(\d+(?:\.\d+)?)\s*%/)
  return m ? Number(m[1]) / 100 : null
}

/** Does the partner's free-text markets mention the deal's state (abbrev/full) or market/submarket? */
function geoMention(markets: string | null, d: MatchDeal): SignalStatus {
  if (!markets || !markets.trim()) return 'na'
  const hay = markets.toLowerCase()
  const needles = [
    d.state ? d.state.toLowerCase() : '',
    d.state && US_STATES[d.state.toUpperCase()] ? US_STATES[d.state.toUpperCase()] : '',
    d.market ? d.market.toLowerCase() : '',
    d.submarket ? d.submarket.toLowerCase() : '',
  ].filter(Boolean) as string[]
  // "national" / "nationwide" mandates fit anywhere
  if (/national|nationwide|all markets|u\.?s\.?-wide/.test(hay)) return 'hit'
  return needles.some(n => n.length >= 2 && hay.includes(n)) ? 'hit' : 'na'
}

const TIER_BONUS: Record<MatchPartner['tier'], number> = { current: 0.5, tier1_prospect: 0.25, tier2_prospect: 0 }

/** Score one deal against one partner mandate. */
export function matchPartner(d: MatchDeal, p: MatchPartner): PartnerMatch {
  const signals: MatchSignal[] = []
  let score = 0

  // product type (structured, weighted highest)
  if (!p.productTypes.length) signals.push({ label: 'Product type', status: 'na', detail: 'agnostic' })
  else if (p.productTypes.includes(d.assetType)) { signals.push({ label: 'Product type', status: 'hit', detail: d.assetType }); score += 2 }
  else { signals.push({ label: 'Product type', status: 'miss', detail: p.productTypes.join('/') }); score -= 3 }

  // deal size ($ range parsed from free text)
  const range = parseMoneyRange(p.dealSize)
  if (!range || d.askPrice == null) signals.push({ label: 'Deal size', status: 'na', detail: p.dealSize ?? undefined })
  else if (d.askPrice >= range[0] && d.askPrice <= range[1]) { signals.push({ label: 'Deal size', status: 'hit', detail: p.dealSize ?? undefined }); score += 1 }
  else { signals.push({ label: 'Deal size', status: 'miss', detail: p.dealSize ?? undefined }); score -= 1 }

  // return target (% parsed from free text)
  const tgt = parsePct(p.returnTarget)
  if (tgt == null || d.projIrr == null) signals.push({ label: 'Return', status: 'na', detail: p.returnTarget ?? undefined })
  else if (d.projIrr >= tgt) { signals.push({ label: 'Return', status: 'hit', detail: `${p.returnTarget} vs ${(d.projIrr * 100).toFixed(1)}%` }); score += 1 }
  else { signals.push({ label: 'Return', status: 'miss', detail: `${p.returnTarget} vs ${(d.projIrr * 100).toFixed(1)}%` }); score -= 0.5 }

  // geography (free-text mention)
  const geo = geoMention(p.markets, d)
  signals.push({ label: 'Geography', status: geo, detail: p.markets ?? undefined })
  if (geo === 'hit') score += 1

  score += TIER_BONUS[p.tier]
  return { partner: p, score, signals }
}

/** Rank active partners not already on the deal by mandate fit (best first). */
export function rankPartners(d: MatchDeal, partners: MatchPartner[], excludeIds: Set<string>): PartnerMatch[] {
  return partners
    .filter(p => p.active && !excludeIds.has(p.id))
    .map(p => matchPartner(d, p))
    .sort((a, b) => b.score - a.score)
}
