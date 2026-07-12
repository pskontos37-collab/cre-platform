import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'
import { num } from './useFinancials'
import { computeWALT } from '../lib/financials'

export interface RolloverYear { year: number; sf: number; count: number; pct: number }
export interface TopTenant { tenant: string; annualRent: number; sf: number; pct: number; leaseEnd: string | null }

// One property's leasing metrics from its latest snapshot.
export interface PropertyRentRoll {
  propertyId: string
  asOf: { year: number; month: number }
  tenantCount: number
  leasedSf: number
  totalGla: number
  totalAnnualRent: number
  avgPsf: number
  walt: number
}

export interface RentRollData {
  asOf: { year: number; month: number } | null
  tenantCount: number
  leasedSf: number
  totalGla: number                 // Σ properties.total_sf for the filtered set
  totalAnnualRent: number
  avgPsf: number
  walt: number
  rollover: RolloverYear[]
  topTenants: TopTenant[]
  byProperty: PropertyRentRoll[]
}

interface RRRow {
  property_id: string; snapshot_id: string; tenant_name: string | null
  sqft: number | null; annual_base_rent: number | null; lease_end: string | null; is_occupied: boolean
}

const EMPTY: RentRollData = { asOf: null, tenantCount: 0, leasedSf: 0, totalGla: 0, totalAnnualRent: 0, avgPsf: 0, walt: 0, rollover: [], topTenants: [], byProperty: [] }

export function useRentRoll(propertyIds: string[]) {
  return useQuery<RentRollData>(async () => {
    if (!propertyIds.length) return EMPTY

    // Latest snapshot per property
    const { data: snaps, error: sErr } = await supabase
      .from('rent_roll_snapshots')
      .select('id, property_id, period_year, period_month')
      .in('property_id', propertyIds)
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false })
    if (sErr) throw new Error(sErr.message)
    if (!snaps?.length) return EMPTY

    const latestByProp = new Map<string, { id: string; year: number; month: number }>()
    for (const s of snaps as any[]) {
      if (!latestByProp.has(s.property_id)) {
        latestByProp.set(s.property_id, { id: s.id, year: Number(s.period_year), month: Number(s.period_month) })
      }
    }
    const snapshotIds = [...latestByProp.values()].map(s => s.id)
    const asOf = [...latestByProp.values()].sort((a, b) => (b.year * 12 + b.month) - (a.year * 12 + a.month))[0] ?? null

    // Total GLA of the properties contributing rent-roll data (only those —
    // mixing in properties without a rent roll would distort leased-vs-GLA).
    const { data: props, error: pErr } = await supabase
      .from('properties')
      .select('id, total_sf')
      .in('id', [...latestByProp.keys()])
    if (pErr) throw new Error(pErr.message)
    const totalGla = ((props ?? []) as any[]).reduce((s, p) => s + num(p.total_sf), 0)

    const { data: rows, error: rErr } = await supabase
      .from('rent_roll_rows')
      .select('property_id, snapshot_id, tenant_name, sqft, annual_base_rent, lease_end, is_occupied')
      .in('snapshot_id', snapshotIds)
    if (rErr) throw new Error(rErr.message)

    const occupied = ((rows ?? []) as RRRow[]).filter(r => r.is_occupied)
    const leasedSf = occupied.reduce((s, r) => s + num(r.sqft), 0)
    const totalAnnualRent = occupied.reduce((s, r) => s + num(r.annual_base_rent), 0)
    const tenantCount = occupied.filter(r => (r.tenant_name ?? '').trim().length > 0).length

    // WALT from lease_end dates (rows that have one)
    const today = new Date()
    const withEnd = occupied.filter(r => r.lease_end)
    const walt = computeWALT(withEnd.map(r => ({ leasedSf: num(r.sqft), expirationDate: r.lease_end as string })), today)

    // Rollover by expiration year
    const yearMap = new Map<number, { sf: number; count: number }>()
    for (const r of withEnd) {
      const y = new Date(r.lease_end as string).getFullYear()
      const prev = yearMap.get(y) ?? { sf: 0, count: 0 }
      yearMap.set(y, { sf: prev.sf + num(r.sqft), count: prev.count + 1 })
    }
    const rolloverSf = withEnd.reduce((s, r) => s + num(r.sqft), 0)
    const rollover = [...yearMap.entries()].sort(([a], [b]) => a - b)
      .map(([year, v]) => ({ year, sf: v.sf, count: v.count, pct: rolloverSf > 0 ? v.sf / rolloverSf : 0 }))

    // Top tenants by annual rent
    const topTenants = occupied
      .filter(r => num(r.annual_base_rent) > 0)
      .map(r => ({ tenant: (r.tenant_name ?? 'Unknown').trim(), annualRent: num(r.annual_base_rent), sf: num(r.sqft),
        pct: totalAnnualRent > 0 ? num(r.annual_base_rent) / totalAnnualRent : 0, leaseEnd: r.lease_end }))
      .sort((a, b) => b.annualRent - a.annualRent)
      .slice(0, 10)

    // Per-property metrics from the same occupied rows.
    const glaOf = new Map(((props ?? []) as any[]).map(p => [p.id, num(p.total_sf)]))
    const byProperty: PropertyRentRoll[] = [...latestByProp.entries()].map(([pid, snap]) => {
      const mine = occupied.filter(r => r.property_id === pid)
      const pLeased = mine.reduce((s, r) => s + num(r.sqft), 0)
      const pRent = mine.reduce((s, r) => s + num(r.annual_base_rent), 0)
      const pWithEnd = mine.filter(r => r.lease_end)
      return {
        propertyId: pid,
        asOf: { year: snap.year, month: snap.month },
        tenantCount: mine.filter(r => (r.tenant_name ?? '').trim().length > 0).length,
        leasedSf: pLeased,
        totalGla: glaOf.get(pid) ?? 0,
        totalAnnualRent: pRent,
        avgPsf: pLeased > 0 ? pRent / pLeased : 0,
        walt: computeWALT(pWithEnd.map(r => ({ leasedSf: num(r.sqft), expirationDate: r.lease_end as string })), today),
      }
    })

    return {
      asOf: asOf ? { year: asOf.year, month: asOf.month } : null,
      tenantCount, leasedSf, totalGla, totalAnnualRent,
      avgPsf: leasedSf > 0 ? totalAnnualRent / leasedSf : 0,
      walt, rollover, topTenants, byProperty,
    }
  }, [propertyIds.join(',')])
}
