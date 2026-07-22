import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'
import { occupancyCostRatio, type CoverageStatus } from '../lib/leaseMath'
import {
  computeNOI,
  computeDSCR,
  computeDSCRHeadroom,
  computeWALT,
  computePhysicalOccupancy,
  computeTrailing12NOI,
  INCOME_CATEGORIES,
  EXPENSE_CATEGORIES,
} from '../lib/financials'
import type {
  OperatingCategory,
  FinancialPeriod,
  OperatingLineItem,
  Loan,
  CoTenancyFlag,
} from '../types/database'

// ── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

// ── NOI ──────────────────────────────────────────────────────────────────────

export interface NOILineRow {
  category: OperatingCategory
  label: string
  actual: number
  budget: number | null
  priorYear: number | null
}

export interface NOIData {
  t12Noi: number
  incomeLines: NOILineRow[]
  expenseLines: NOILineRow[]
  totalIncome: number
  totalExpenses: number
  currentNoi: number
  budgetNoi: number | null
  priorYearNoi: number | null
}

const CATEGORY_LABELS: Partial<Record<OperatingCategory, string>> = {
  base_rent:          'Base rent',
  percentage_rent:    'Pct rent',
  cam_recovery:       'CAM recovery',
  other_income:       'Other income',
  management_fee:     'Mgmt fee',
  taxes:              'RE tax',
  insurance:          'Insurance',
  utilities:          'Utilities',
  repairs_maintenance:'Maintenance',
  other_expense:      'Other expense',
  operating_expenses: 'Operating expenses',
}

export function useNOI(propertyIds: string[]) {
  return useQuery<NOIData>(async () => {
    if (!propertyIds.length) return emptyNOI()

    const twoYearsAgo = new Date()
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2)

    const { data: periods, error: pErr } = await supabase
      .from('financial_periods')
      .select('*')
      .in('property_id', propertyIds)
      .gte('period_start', twoYearsAgo.toISOString().split('T')[0])
      .order('period_start', { ascending: true })

    if (pErr) throw new Error(pErr.message)
    if (!periods?.length) return emptyNOI()

    const periodsArr = periods as FinancialPeriod[]
    const { data: items, error: iErr } = await supabase
      .from('operating_line_items')
      .select('category, amount, financial_period_id')
      .in('financial_period_id', periodsArr.map(p => p.id))

    if (iErr) throw new Error(iErr.message)
    const itemsArr = (items ?? []) as Pick<OperatingLineItem, 'category' | 'amount' | 'financial_period_id'>[]

    // T12 NOI
    const actualPeriods = periodsArr.filter(p => !p.is_budget)
    const t12Noi = computeTrailing12NOI(
      actualPeriods.map(p => ({
        isActual: true,
        lineItems: itemsArr.filter(i => i.financial_period_id === p.id),
      }))
    )

    // Most recent actual period
    const latestActual = [...actualPeriods].sort((a, b) =>
      b.period_start.localeCompare(a.period_start)
    )[0]
    const latestItems = latestActual
      ? itemsArr.filter(i => i.financial_period_id === latestActual.id)
      : []
    const latestNOI = latestItems.length ? computeNOI(latestItems) : null

    // Matching budget period (same period_start)
    const budgetPeriods = periodsArr.filter(p => p.is_budget)
    const matchBudget = latestActual
      ? budgetPeriods.find(p => p.period_start === latestActual.period_start)
      : null
    const budgetItems = matchBudget ? itemsArr.filter(i => i.financial_period_id === matchBudget.id) : []
    const budgetNOI = budgetItems.length ? computeNOI(budgetItems) : null

    // Prior-year actual (12 months before latest)
    const pyDate = latestActual ? new Date(latestActual.period_start) : null
    if (pyDate) pyDate.setFullYear(pyDate.getFullYear() - 1)
    const pyPeriod = pyDate
      ? actualPeriods.find(p => p.period_start.startsWith(pyDate.toISOString().split('T')[0].slice(0, 7)))
      : null
    const pyItems = pyPeriod ? itemsArr.filter(i => i.financial_period_id === pyPeriod.id) : []
    const pyNOI = pyItems.length ? computeNOI(pyItems) : null

    function buildRows(cats: OperatingCategory[]): NOILineRow[] {
      return cats.map(cat => ({
        category: cat,
        label: CATEGORY_LABELS[cat] ?? cat,
        actual: latestItems.filter(i => i.category === cat).reduce((s, i) => s + i.amount, 0),
        budget: budgetItems.length
          ? budgetItems.filter(i => i.category === cat).reduce((s, i) => s + i.amount, 0)
          : null,
        priorYear: pyItems.length
          ? pyItems.filter(i => i.category === cat).reduce((s, i) => s + i.amount, 0)
          : null,
      })).filter(r => r.actual !== 0 || r.budget !== null)
    }

    return {
      t12Noi,
      incomeLines:  buildRows(INCOME_CATEGORIES),
      expenseLines: buildRows(EXPENSE_CATEGORIES),
      totalIncome:  latestNOI?.totalIncome  ?? 0,
      totalExpenses:latestNOI?.totalExpenses ?? 0,
      currentNoi:   latestNOI?.noi ?? 0,
      budgetNoi:    budgetNOI?.noi ?? null,
      priorYearNoi: pyNOI?.noi    ?? null,
    }
  }, [propertyIds.join(',')])
}

function emptyNOI(): NOIData {
  return { t12Noi: 0, incomeLines: [], expenseLines: [], totalIncome: 0, totalExpenses: 0, currentNoi: 0, budgetNoi: null, priorYearNoi: null }
}

// ── DSCR ─────────────────────────────────────────────────────────────────────

export interface LoanDSCRRow {
  loan: Loan
  propertyName: string
  t12Noi: number | null
  dscr: number | null
  debtYield: number | null
  ltv: number | null
  /** Headroom vs the governing covenant — DSCR points (x) for dscr, decimal pct points for debt_yield. */
  headroom: number | null
  covenantType: 'debt_yield' | 'dscr' | null
  isNear: boolean
  isBreach: boolean
}

export function useDSCR(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<LoanDSCRRow[]>(async () => {
    if (!propertyIds.length) return []

    const { data: loans, error } = await supabase
      .from('loans')
      .select('*')
      .in('property_id', propertyIds)

    if (error) throw new Error(error.message)
    const loansArr = (loans ?? []) as Loan[]
    if (!loansArr.length) return []

    // A loan's covenants measure against the NOI of the assets that secure it.
    // collateral_property_ids names the GL-bearing properties; fall back to the loan's
    // own property (e.g. the cross-collateralized MetLife loan sits on the KM
    // "Consolidated" entity, which has no GL — its NOI is KM East + KM West).
    const collateralOf = (l: Loan): string[] =>
      l.collateral_property_ids && l.collateral_property_ids.length ? l.collateral_property_ids : [l.property_id]
    const allCollateral = [...new Set(loansArr.flatMap(collateralOf))]

    // GL-derived monthly NOI (the reliable, penny-accurate source) for every collateral property.
    const { data: monthly, error: mErr } = await supabase
      .from('v_gl_pnl_monthly')
      .select('property_id, period_year, period_month, noi')
      .in('property_id', allCollateral)
    if (mErr) throw new Error(mErr.message)
    const monthlyArr = (monthly ?? []) as Array<{ property_id: string; period_year: number; period_month: number; noi: number | null }>

    // Trailing-12 NOI combined across a set of properties: aggregate by calendar month,
    // then sum the most recent 12 months present (matches useGlPnl's T12 window).
    const t12For = (propIds: string[]): number | null => {
      const set = new Set(propIds)
      const byKey = new Map<number, number>()
      for (const r of monthlyArr) {
        if (!set.has(r.property_id)) continue
        const key = Number(r.period_year) * 12 + Number(r.period_month)
        byKey.set(key, (byKey.get(key) ?? 0) + Number(r.noi ?? 0))
      }
      if (!byKey.size) return null
      return [...byKey.keys()].sort((a, b) => a - b).slice(-12).reduce((s, k) => s + (byKey.get(k) ?? 0), 0)
    }

    return loansArr.map(loan => {
      const t12Noi = t12For(collateralOf(loan))
      const ads = loan.annual_debt_service
      const bal = loan.outstanding_balance

      const dscr = ads && t12Noi !== null ? computeDSCR(t12Noi, ads) : null
      const debtYield = bal && bal > 0 && t12Noi !== null ? t12Noi / bal : null
      // LTV needs a current appraised value, which we don't track yet.
      const ltv: number | null = null

      // Evaluate the covenant that actually governs this loan: debt yield (MetLife) or DSCR.
      let covenantType: 'debt_yield' | 'dscr' | null = null
      let headroom: number | null = null
      let isBreach = false
      let isNear = false
      if (loan.debt_yield_covenant != null && debtYield != null) {
        covenantType = 'debt_yield'
        headroom = debtYield - loan.debt_yield_covenant
        isBreach = headroom < 0
        isNear = !isBreach && headroom < 0.01            // within 1 percentage point
      } else if (loan.dscr_covenant != null && dscr != null && ads && t12Noi !== null) {
        covenantType = 'dscr'
        const hr = computeDSCRHeadroom(t12Noi, ads, loan.dscr_covenant)
        headroom = hr.headroom
        isBreach = hr.isBreach
        isNear = !hr.isBreach && (hr.headroom ?? 0) < 0.10
      }

      return {
        loan,
        propertyName: propertyNames[loan.property_id] ?? 'Unknown',
        t12Noi, dscr, debtYield, ltv,
        headroom, covenantType, isNear, isBreach,
      }
    })
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}

// ── Occupancy ────────────────────────────────────────────────────────────────

export interface OccupancyByProperty {
  propertyId: string
  propertyName: string
  physicalPct: number
  occupiedSf: number
  totalSf: number
  vacantSf: number
}

export interface OccupancyData {
  physicalPct: number
  occupiedSf: number
  totalSf: number
  byProperty: OccupancyByProperty[]
}

export function useOccupancy(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<OccupancyData>(async () => {
    if (!propertyIds.length) return { physicalPct: 0, occupiedSf: 0, totalSf: 0, byProperty: [] }

    const { data: units, error } = await supabase
      .from('units')
      .select('property_id, status, rentable_sf')
      .in('property_id', propertyIds)

    if (error) throw new Error(error.message)
    const unitsArr = (units ?? []) as { property_id: string; status: string; rentable_sf: number | null }[]

    let totalOccupied = 0
    let totalSf = 0

    const byProperty: OccupancyByProperty[] = propertyIds.map(pid => {
      const propUnits = unitsArr.filter(u => u.property_id === pid)
      const occupiedSf = propUnits
        .filter(u => u.status === 'occupied')
        .reduce((s, u) => s + (u.rentable_sf ?? 0), 0)
      const propSf = propUnits.reduce((s, u) => s + (u.rentable_sf ?? 0), 0)
      totalOccupied += occupiedSf
      totalSf += propSf
      return {
        propertyId:   pid,
        propertyName: propertyNames[pid] ?? 'Unknown',
        physicalPct:  computePhysicalOccupancy(occupiedSf, propSf),
        occupiedSf,
        totalSf:      propSf,
        vacantSf:     propSf - occupiedSf,
      }
    })

    return {
      physicalPct: computePhysicalOccupancy(totalOccupied, totalSf),
      occupiedSf: totalOccupied,
      totalSf,
      byProperty,
    }
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}

// ── Lease Rollover & WALT ─────────────────────────────────────────────────────

export interface RolloverYear {
  year: number
  sf: number
  count: number
  pctOfTotal: number
}

// One property's rollover slice — same shape as the portfolio roll-up, so the
// executive snapshot can render per-property WALT and rollover from the same
// computation. Additive: existing consumers (RolloverWidget) ignore byProperty.
export interface PropertyRollover {
  propertyId: string
  walt: number
  byYear: RolloverYear[]
  totalLeasedSf: number
}

export interface RolloverData {
  walt: number
  byYear: RolloverYear[]
  totalLeasedSf: number
  byProperty: PropertyRollover[]
}

// Roll a set of active (future-dated) leases into WALT + by-year + total SF.
function rollupLeases(
  active: { leased_sf: number | null; expiration_date: string }[],
  today: Date,
): { walt: number; byYear: RolloverYear[]; totalLeasedSf: number } {
  const yearMap = new Map<number, { sf: number; count: number }>()
  for (const l of active) {
    const year = new Date(l.expiration_date).getFullYear()
    const prev = yearMap.get(year) ?? { sf: 0, count: 0 }
    yearMap.set(year, { sf: prev.sf + (l.leased_sf ?? 0), count: prev.count + 1 })
  }
  const totalLeasedSf = active.reduce((s, l) => s + (l.leased_sf ?? 0), 0)
  const byYear = Array.from(yearMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([year, { sf, count }]) => ({ year, sf, count, pctOfTotal: totalLeasedSf > 0 ? sf / totalLeasedSf : 0 }))
  const walt = computeWALT(active.map(l => ({ leasedSf: l.leased_sf ?? 0, expirationDate: l.expiration_date })), today)
  return { walt, byYear, totalLeasedSf }
}

export function useLeaseRollover(propertyIds: string[]) {
  return useQuery<RolloverData>(async () => {
    if (!propertyIds.length) return { walt: 0, byYear: [], totalLeasedSf: 0, byProperty: [] }

    const { data: leases, error } = await supabase
      .from('leases')
      .select('id, property_id, leased_sf, expiration_date, status')
      .in('property_id', propertyIds)
      .eq('status', 'active')
      .not('expiration_date', 'is', null)

    if (error) throw new Error(error.message)
    const leasesArr = (leases ?? []) as { id: string; property_id: string; leased_sf: number | null; expiration_date: string; status: string }[]

    const today = new Date()
    const active = leasesArr.filter(l => new Date(l.expiration_date) > today)

    const byPropMap = new Map<string, { leased_sf: number | null; expiration_date: string }[]>()
    for (const l of active) {
      const arr = byPropMap.get(l.property_id) ?? []
      arr.push({ leased_sf: l.leased_sf, expiration_date: l.expiration_date })
      byPropMap.set(l.property_id, arr)
    }
    const byProperty: PropertyRollover[] = [...byPropMap.entries()]
      .map(([propertyId, ls]) => ({ propertyId, ...rollupLeases(ls, today) }))

    return { ...rollupLeases(active, today), byProperty }
  }, [propertyIds.join(',')])
}

// ── Critical Dates ────────────────────────────────────────────────────────────

export interface CriticalDateRow {
  id: string
  propertyId: string
  propertyName: string
  tenantName: string | null
  dateType: string
  dueDate: string
  description: string | null
  daysUntil: number
  loanId: string | null
  leaseId: string | null
  status: string
  requiresLandlordReminder: boolean
}

export function useCriticalDates(propertyIds: string[], propertyNames: Record<string, string>, days = 90) {
  return useQuery<CriticalDateRow[]>(async () => {
    if (!propertyIds.length) return []

    const today = new Date()
    const horizon = new Date()
    horizon.setDate(horizon.getDate() + days)

    // P1d-c: read the single critical-event LEDGER (active_critical_events =
    // open/in-progress, historical & superseded excluded), replacing the legacy
    // critical_dates store. Dated events only, within the horizon. dateType now
    // carries the ledger event_type (lease_expiration/option_notice/loan_maturity/
    // mgmt_termination_notice/recurring_obligation); consumers render it as a label.
    const { data, error } = await supabase
      .from('active_critical_events')
      .select('id, property_id, lease_id, loan_id, event_type, computed_date, title, description, status, requires_landlord_reminder')
      .in('property_id', propertyIds)
      .not('computed_date', 'is', null)
      .gte('computed_date', today.toISOString().split('T')[0])
      .lte('computed_date', horizon.toISOString().split('T')[0])
      .order('computed_date')
      .limit(50)

    if (error) throw new Error(error.message)

    return ((data ?? []) as any[]).map(row => ({
      id:           row.id,
      propertyId:   row.property_id,
      propertyName: propertyNames[row.property_id] ?? 'Unknown',
      tenantName:   null,
      dateType:     row.event_type,
      dueDate:      row.computed_date,
      description:  row.title ?? row.description,
      daysUntil:    Math.ceil((new Date(row.computed_date).getTime() - today.getTime()) / 86_400_000),
      loanId:       row.loan_id,
      leaseId:      row.lease_id,
      status:       row.status ?? 'open',
      requiresLandlordReminder: row.requires_landlord_reminder ?? false,
    }))
  }, [propertyIds.join(','), JSON.stringify(propertyNames), days])
}

// ── Option-date reconciliation (critical-event ledger, P1d) ───────────────────
// The deterministic generator computes each option-notice deadline as
// (current-term expiration - notice_days) and cross-checks the stored MRI value.
// Where they disagree it flags 'deterministic_differs_from_mri' — a worklist of
// option dates that may be stale (e.g. never updated after a term extension, the
// Starbucks/Kay-Jewelers failure). Read-only: the ledger surfaces the conflict
// for a human to adjudicate; it never silently overwrites either value.

export interface EventReconRow {
  id: string
  propertyName: string
  title: string
  computedDate: string
  mriValue: string | null
  dayGap: number | null       // stored − computed, in days (magnitude = how far off)
  formula: string | null
}

export function useEventReconciliation(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<EventReconRow[]>(async () => {
    if (!propertyIds.length) return []
    const { data, error } = await supabase
      .from('critical_events')
      .select('id, property_id, title, computed_date, mri_value, formula')
      .in('property_id', propertyIds)
      .eq('event_type', 'option_notice')
      .eq('reconciliation_status', 'deterministic_differs_from_mri')
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[])
      .map(r => ({
        id:           r.id,
        propertyName: propertyNames[r.property_id] ?? 'Unknown',
        title:        r.title,
        computedDate: r.computed_date,
        mriValue:     r.mri_value,
        dayGap:       r.mri_value && r.computed_date
          ? Math.round((new Date(r.mri_value).getTime() - new Date(r.computed_date).getTime()) / 86_400_000)
          : null,
        formula:      r.formula,
      }))
      // Worst (largest absolute gap) first — the stale-by-years cases lead.
      .sort((a, b) => Math.abs(b.dayGap ?? 0) - Math.abs(a.dayGap ?? 0))
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}

// ── Accounts Receivable (GL-derived net A/R) ─────────────────────────────────

export interface ArTrendData {
  latestMonth: number
  totalLatest: number
  trend: Array<{ month: number; balance: number }>          // portfolio, months 1..latest
  // monthly = forward-filled balances for months 1..latest (same window as trend)
  byProperty: Array<{ propertyId: string; propertyName: string; balance: number; monthly: number[] }>
}

export function useArTrend(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<ArTrendData | null>(async () => {
    if (!propertyIds.length) return null
    const { data, error } = await supabase
      .from('v_gl_ar_monthly')
      .select('property_id, period_month, ar_balance')
      .in('property_id', propertyIds)
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as any[]
    if (!rows.length) return null

    // Forward-fill each property's cumulative balance across months so a month
    // with no A/R activity carries the prior balance.
    const byProp = new Map<string, Map<number, number>>()
    let latestMonth = 1
    for (const r of rows) {
      if (!byProp.has(r.property_id)) byProp.set(r.property_id, new Map())
      byProp.get(r.property_id)!.set(Number(r.period_month), Number(r.ar_balance))
      latestMonth = Math.max(latestMonth, Number(r.period_month))
    }
    const filled = new Map<string, number[]>()   // property -> balance[month 1..latest]
    for (const [pid, months] of byProp) {
      const arr: number[] = []
      let last = 0
      for (let m = 1; m <= latestMonth; m++) {
        if (months.has(m)) last = months.get(m)!
        arr.push(last)
      }
      filled.set(pid, arr)
    }
    const trend = Array.from({ length: latestMonth }, (_, i) => ({
      month: i + 1,
      balance: [...filled.values()].reduce((s, arr) => s + arr[i], 0),
    }))
    const byProperty = [...filled.entries()]
      .map(([pid, arr]) => ({ propertyId: pid, propertyName: propertyNames[pid] ?? 'Unknown', balance: arr[latestMonth - 1], monthly: arr }))
      .sort((a, b) => b.balance - a.balance)
    return { latestMonth, totalLatest: trend[latestMonth - 1].balance, trend, byProperty }
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}

// ── Co-Tenancy Flags ──────────────────────────────────────────────────────────

export function useCoTenancyFlags(propertyIds: string[]) {
  return useQuery<CoTenancyFlag[]>(async () => {
    if (!propertyIds.length) return []

    // Auto-flag: materialize pending flags for clauses whose conditions currently fail
    // (sync_co_tenancy_flags RPC, migration 20240072). Best-effort — reading existing
    // flags still works if the RPC isn't deployed yet.
    try { await supabase.rpc('sync_co_tenancy_flags') } catch { /* pre-20240072 */ }

    const { data, error } = await supabase
      .from('co_tenancy_flags')
      .select('*')
      .in('property_id', propertyIds)
      .eq('status', 'pending_review')
      .order('triggered_at', { ascending: false })

    if (error) throw new Error(error.message)
    return (data ?? []) as CoTenancyFlag[]
  }, [propertyIds.join(',')])
}

// ── Tenant Concentration ──────────────────────────────────────────────────────

export interface ConcentrationRow {
  tenantId: string
  tenantName: string
  propertyName: string
  annualRent: number
  pctOfTotal: number
  leasedSf: number
}

export function useTenantConcentration(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<ConcentrationRow[]>(async () => {
    if (!propertyIds.length) return []

    const { data, error } = await supabase
      .from('leases')
      .select('tenant_id, property_id, leased_sf, lease_rent_schedule(annual_rent, effective_date), tenant:tenants(id, name)')
      .in('property_id', propertyIds)
      .eq('status', 'active')

    if (error) throw new Error(error.message)

    const today = new Date()
    const tenantMap = new Map<string, { name: string; rent: number; sf: number; propId: string }>()

    for (const lease of (data ?? []) as any[]) {
      const schedules: any[] = (lease.lease_rent_schedule ?? [])
        .filter((s: any) => new Date(s.effective_date) <= today)
        .sort((a: any, b: any) => b.effective_date.localeCompare(a.effective_date))

      const annualRent = schedules[0]?.annual_rent ?? 0
      const tid = lease.tenant_id
      const prev = tenantMap.get(tid) ?? { name: lease.tenant?.name ?? 'Unknown', rent: 0, sf: 0, propId: lease.property_id }
      tenantMap.set(tid, { name: prev.name, rent: prev.rent + annualRent, sf: prev.sf + (lease.leased_sf ?? 0), propId: lease.property_id })
    }

    const total = Array.from(tenantMap.values()).reduce((s, t) => s + t.rent, 0)

    return Array.from(tenantMap.entries())
      .map(([tenantId, t]) => ({
        tenantId,
        tenantName:   t.name,
        propertyName: propertyNames[t.propId] ?? '',
        annualRent:   t.rent,
        pctOfTotal:   total > 0 ? t.rent / total : 0,
        leasedSf:     t.sf,
      }))
      .sort((a, b) => b.annualRent - a.annualRent)
      .slice(0, 10)
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}

// Top tenants ranked WITHIN each property (pct of that property's ABR), for the
// executive snapshot's per-property table (#1 tenant) and detail pages (top N).
// Separate from useTenantConcentration, which ranks the whole scope's top 10.
export function usePropertyTopTenants(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<Record<string, ConcentrationRow[]>>(async () => {
    if (!propertyIds.length) return {}

    const { data, error } = await supabase
      .from('leases')
      .select('tenant_id, property_id, leased_sf, lease_rent_schedule(annual_rent, effective_date), tenant:tenants(id, name)')
      .in('property_id', propertyIds)
      .eq('status', 'active')

    if (error) throw new Error(error.message)

    const today = new Date()
    // property_id -> tenant_id -> aggregate
    const byProp = new Map<string, Map<string, { name: string; rent: number; sf: number }>>()
    for (const lease of (data ?? []) as any[]) {
      const schedules: any[] = (lease.lease_rent_schedule ?? [])
        .filter((s: any) => new Date(s.effective_date) <= today)
        .sort((a: any, b: any) => b.effective_date.localeCompare(a.effective_date))
      const annualRent = schedules[0]?.annual_rent ?? 0
      const tid = lease.tenant_id
      const tenants = byProp.get(lease.property_id) ?? new Map()
      const prev = tenants.get(tid) ?? { name: lease.tenant?.name ?? 'Unknown', rent: 0, sf: 0 }
      tenants.set(tid, { name: prev.name, rent: prev.rent + annualRent, sf: prev.sf + (lease.leased_sf ?? 0) })
      byProp.set(lease.property_id, tenants)
    }

    const out: Record<string, ConcentrationRow[]> = {}
    for (const [propId, tenants] of byProp) {
      const total = [...tenants.values()].reduce((s, t) => s + t.rent, 0)
      out[propId] = [...tenants.entries()]
        .map(([tenantId, t]) => ({
          tenantId,
          tenantName:   t.name,
          propertyName: propertyNames[propId] ?? '',
          annualRent:   t.rent,
          pctOfTotal:   total > 0 ? t.rent / total : 0,
          leasedSf:     t.sf,
        }))
        .sort((a, b) => b.annualRent - a.annualRent)
        .slice(0, 12)
    }
    return out
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}

// ── Delinquency (MRI A/R aging snapshots) ─────────────────────────────────────

export interface DelinquencyRow {
  id: string
  tenantName: string
  propertyName: string
  suite: string | null
  total: number
  current: number
  b30: number
  b60: number
  b90: number
  b120: number
  pastDue: number
  lastPaymentDate: string | null
  asOf: string
}

export function useDelinquency(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<DelinquencyRow[]>(async () => {
    if (!propertyIds.length) return []

    const { data, error } = await supabase
      .from('ar_aging')
      .select('id, property_id, as_of_date, tenant_label, suite, total, bucket_current, bucket_30, bucket_60, bucket_90, bucket_120, last_payment_date, tenant:tenants(name)')
      .in('property_id', propertyIds)
      .order('as_of_date', { ascending: false })
      .limit(500)

    if (error) throw new Error(error.message)

    const rows = (data ?? []) as any[]
    if (!rows.length) return []
    // keep only the latest snapshot per property
    const latest: Record<string, string> = {}
    for (const r of rows) {
      if (!latest[r.property_id] || r.as_of_date > latest[r.property_id]) latest[r.property_id] = r.as_of_date
    }
    return rows
      .filter(r => r.as_of_date === latest[r.property_id])
      .map(row => {
        const b30 = Number(row.bucket_30 ?? 0), b60 = Number(row.bucket_60 ?? 0)
        const b90 = Number(row.bucket_90 ?? 0), b120 = Number(row.bucket_120 ?? 0)
        return {
          id:              row.id,
          tenantName:      row.tenant?.name ?? row.tenant_label,
          propertyName:    propertyNames[row.property_id] ?? 'Unknown',
          suite:           row.suite,
          total:           Number(row.total ?? 0),
          current:         Number(row.bucket_current ?? 0),
          b30, b60, b90, b120,
          pastDue:         b30 + b60 + b90 + b120,
          lastPaymentDate: row.last_payment_date,
          asOf:            row.as_of_date,
        }
      })
      .filter(r => r.pastDue > 0.005)
      .sort((a, b) => b.pastDue - a.pastDue)
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}

// ── CAM Reconciliation ────────────────────────────────────────────────────────

export interface CAMReconRow {
  id: string
  propertyName: string
  tenantName: string | null
  periodYear: number
  recType: 'cam' | 'ins' | 'ret'
  estimatedAmount: number | null
  actualAmount: number | null
  variance: number | null
  status: string
  dueDate: string | null
}

export function useCAMRecon(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<CAMReconRow[]>(async () => {
    if (!propertyIds.length) return []

    const { data, error } = await supabase
      .from('cam_reconciliations')
      .select('id, property_id, period_year, rec_type, estimated_amount, actual_amount, status, due_date, notes, tenant:tenants(name)')
      .in('property_id', propertyIds)
      .neq('status', 'complete')
      .order('due_date', { nullsFirst: false })
      .limit(100)

    if (error) throw new Error(error.message)

    return ((data ?? []) as any[]).map(row => ({
      id:               row.id,
      propertyName:     propertyNames[row.property_id] ?? 'Unknown',
      // loader notes carry "tenant: <name>" for rows without a lease-model match
      tenantName:       row.tenant?.name ?? (row.notes?.match(/tenant: ([^|]+)/)?.[1]?.trim() || null),
      periodYear:       row.period_year,
      recType:          row.rec_type ?? 'cam',
      estimatedAmount:  row.estimated_amount,
      actualAmount:     row.actual_amount,
      variance:         row.actual_amount != null && row.estimated_amount != null
                          ? row.actual_amount - row.estimated_amount
                          : null,
      status:           row.status,
      dueDate:          row.due_date,
    }))
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}

// ── Percentage Rent ───────────────────────────────────────────────────────────

export interface PctRentRow {
  leaseId: string
  tenantName: string
  propertyName: string
  ytdSales: number
  effectiveBreakpoint: number
  pctRate: number | null
  pctToBreakpoint: number
  estimatedPctRent: number
  willTrigger: boolean
}

export function usePercentageRent(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<PctRentRow[]>(async () => {
    if (!propertyIds.length) return []

    const currentYear = new Date().getFullYear()

    const { data: leases, error: lErr } = await supabase
      .from('leases')
      .select('id, property_id, natural_breakpoint, artificial_breakpoint, percentage_rent_rate, tenant:tenants(name)')
      .in('property_id', propertyIds)
      .eq('status', 'active')
      .eq('has_percentage_rent', true)

    if (lErr) throw new Error(lErr.message)
    if (!leases?.length) return []

    const leaseIds = (leases as any[]).map(l => l.id)

    const { data: records, error: rErr } = await supabase
      .from('pct_rent_records')
      .select('lease_id, reported_sales')
      .in('lease_id', leaseIds)
      .eq('period_year', currentYear)

    if (rErr) throw new Error(rErr.message)

    const salesByLease: Record<string, number> = {}
    for (const rec of (records ?? []) as any[]) {
      salesByLease[rec.lease_id] = (salesByLease[rec.lease_id] ?? 0) + Number(rec.reported_sales ?? 0)
    }

    return (leases as any[]).map(lease => {
      const ytdSales = salesByLease[lease.id] ?? 0
      const bp = Number(lease.natural_breakpoint ?? lease.artificial_breakpoint ?? 0)
      const pctToBreakpoint = bp > 0 ? Math.min(ytdSales / bp, 1) : 0
      const rate = Number(lease.percentage_rent_rate ?? 0)
      const excess = bp > 0 ? Math.max(ytdSales - bp, 0) : 0

      return {
        leaseId:          lease.id,
        tenantName:       lease.tenant?.name ?? 'Unknown',
        propertyName:     propertyNames[lease.property_id] ?? 'Unknown',
        ytdSales,
        effectiveBreakpoint: bp,
        pctRate:          lease.percentage_rent_rate,
        pctToBreakpoint,
        estimatedPctRent: excess * rate,
        willTrigger:      bp > 0 && ytdSales > bp,
      }
    })
      // Keep the widget substantive: hide leases with neither reported sales
      // nor a known breakpoint (data pending), sort by progress-to-breakpoint.
      .filter(r => r.ytdSales > 0 || r.effectiveBreakpoint > 0)
      .sort((a, b) => b.pctToBreakpoint - a.pctToBreakpoint || b.ytdSales - a.ytdSales)
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}

// ── Health Ratio (occupancy cost ÷ sales) ─────────────────────────────────────
// The retail "health ratio" (a.k.a. occupancy-cost ratio) measures how much of a
// tenant's sales is consumed by the cost of occupying the space. Lower = healthier;
// a tenant paying a large share of sales in rent + recoveries is at renewal/closure
// risk. Only tenants that REPORT SALES (percentage-rent leases with sales records)
// can be measured. We use trailing-12-month (TTM) sales — 2026 sales are partial —
// against annual base rent + latest-year expense recoveries (CAM / tax / insurance).

export type HealthBand = 'healthy' | 'watch' | 'high'

export interface HealthRatioRow {
  leaseId: string
  tenantName: string
  propertyName: string
  ttmSales: number
  baseRent: number
  recoveries: number
  occupancyCost: number
  ratio: number | null      // occupancyCost / ttmSales — NULL when coverage is incomplete
  monthsCovered: number      // reported months in the 12-month window
  coverageStatus: CoverageStatus  // 'ok' | 'insufficient_coverage' | 'zero_sales'
  hasRecoveries: boolean    // false → occupancy cost is rent-only (a floor)
  band: HealthBand | null    // null when there is no ratio to band
}

export interface HealthRatioData {
  rows: HealthRatioRow[]
  portfolioRatio: number   // Σ occupancy cost ÷ Σ TTM sales across FULLY-COVERED tenants only
  ttmLabel: string         // e.g. "Jun 2025 – May 2026"
  insufficientCount: number // tenants excluded from the ratio for incomplete sales coverage
}

// Occupancy-cost-ratio thresholds. General-retail rules of thumb: under ~10% is
// healthy, 10–15% bears watching, above 15% is elevated (category-dependent —
// restaurants run leaner than services, so treat as a screen, not a verdict).
const HEALTH_WATCH = 0.10
const HEALTH_HIGH  = 0.15

export const healthBand = (ratio: number): HealthBand =>
  ratio <= HEALTH_WATCH ? 'healthy' : ratio <= HEALTH_HIGH ? 'watch' : 'high'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function useHealthRatio(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<HealthRatioData>(async () => {
    const empty: HealthRatioData = { rows: [], portfolioRatio: 0, ttmLabel: '' }
    if (!propertyIds.length) return empty

    const currentYear = new Date().getFullYear()

    // Sales-reporting leases + their latest annual base rent.
    const { data: leases, error: lErr } = await supabase
      .from('leases')
      .select('id, property_id, tenant:tenants(name), lease_rent_schedule(annual_rent, effective_date)')
      .in('property_id', propertyIds)
      .eq('status', 'active')
      .eq('has_percentage_rent', true)
    if (lErr) throw new Error(lErr.message)
    if (!leases?.length) return empty

    const leaseIds = (leases as any[]).map(l => l.id)

    // Sales records for the current + prior year — enough to cover any TTM window.
    const { data: records, error: rErr } = await supabase
      .from('pct_rent_records')
      .select('lease_id, period_year, period_month, reported_sales')
      .in('lease_id', leaseIds)
      .in('period_year', [currentYear - 1, currentYear])
    if (rErr) throw new Error(rErr.message)

    // Expense recoveries (CAM / tax / insurance) per lease.
    const { data: recons, error: cErr } = await supabase
      .from('cam_reconciliations')
      .select('lease_id, period_year, actual_amount, estimated_amount')
      .in('lease_id', leaseIds)
    if (cErr) throw new Error(cErr.message)

    // Anchor the TTM window on the latest reported month present in the data
    // (sales lag the calendar), then take the 12 months ending there.
    const monthKey = (y: number, m: number) => y * 12 + (m - 1)
    const withMonth = (records ?? []).filter((r: any) => r.period_month != null)
    if (!withMonth.length) return empty
    const latest = Math.max(...withMonth.map((r: any) => monthKey(r.period_year, r.period_month)))
    const windowKeys = new Set(Array.from({ length: 12 }, (_, i) => latest - i))

    // Sum sales AND count how many of the 12 window months are actually reported
    // per lease. Coverage drives whether a ratio may be computed at all — the
    // audit's Dave & Buster's failure was dividing full-year occupancy cost by a
    // partial-year sales sum (7 of 12 months) and showing it as a TTM ratio.
    const ttmSalesByLease: Record<string, number> = {}
    const coveredByLease: Record<string, Set<number>> = {}
    for (const r of withMonth as any[]) {
      const k = monthKey(r.period_year, r.period_month)
      if (!windowKeys.has(k)) continue
      ttmSalesByLease[r.lease_id] = (ttmSalesByLease[r.lease_id] ?? 0) + Number(r.reported_sales ?? 0)
      ;(coveredByLease[r.lease_id] ??= new Set<number>()).add(k)   // a reported month (even $0) counts as covered
    }

    // Recoveries: use each lease's most recent reconciliation year, actual over estimated.
    const recLatestYear: Record<string, number> = {}
    for (const c of (recons ?? []) as any[]) {
      const y = Number(c.period_year ?? 0)
      if (y > (recLatestYear[c.lease_id] ?? 0)) recLatestYear[c.lease_id] = y
    }
    const recByLease: Record<string, number> = {}
    for (const c of (recons ?? []) as any[]) {
      if (Number(c.period_year ?? 0) !== recLatestYear[c.lease_id]) continue
      recByLease[c.lease_id] = (recByLease[c.lease_id] ?? 0) + Number(c.actual_amount ?? c.estimated_amount ?? 0)
    }

    const rows: HealthRatioRow[] = (leases as any[])
      .map(lease => {
        const ttmSales = ttmSalesByLease[lease.id] ?? 0
        const monthsCovered = coveredByLease[lease.id]?.size ?? 0
        const schedules = [...(lease.lease_rent_schedule ?? [])]
          .sort((a: any, b: any) => String(b.effective_date).localeCompare(String(a.effective_date)))
        const baseRent = Number(schedules[0]?.annual_rent ?? 0)
        const recoveries = recByLease[lease.id] ?? 0
        const occupancyCost = baseRent + recoveries
        // Deterministic (src/lib/leaseMath): a TTM ratio needs all 12 months;
        // fewer → insufficient_coverage and NO ratio, never an inflated number.
        const cov = occupancyCostRatio({ occupancyCost, sales: ttmSales, monthsCovered, monthsRequired: 12 })
        return {
          leaseId:       lease.id,
          tenantName:    lease.tenant?.name ?? 'Unknown',
          propertyName:  propertyNames[lease.property_id] ?? 'Unknown',
          ttmSales,
          baseRent,
          recoveries,
          occupancyCost,
          ratio:         cov.ratio,
          monthsCovered,
          coverageStatus: cov.status,
          hasRecoveries: recoveries > 0,
          band:          cov.ratio != null ? healthBand(cov.ratio) : null,
        }
      })
      // Keep tenants with occupancy cost and at least one reported month; an
      // incomplete-coverage tenant is SHOWN (with a coverage note), not silently
      // dropped and not silently ratio'd.
      .filter(r => r.occupancyCost > 0 && r.monthsCovered > 0)
      .sort((a, b) =>
        // computable ratios first (worst burden first), incomplete-coverage last
        (a.ratio == null ? 1 : 0) - (b.ratio == null ? 1 : 0) ||
        (b.ratio ?? 0) - (a.ratio ?? 0))

    // Blend the portfolio ratio over FULLY-COVERED tenants only — mixing partial
    // sales into the denominator would distort it exactly as the per-row bug did.
    const okRows = rows.filter(r => r.coverageStatus === 'ok')
    const totalCost  = okRows.reduce((s, r) => s + r.occupancyCost, 0)
    const totalSales = okRows.reduce((s, r) => s + r.ttmSales, 0)
    const insufficientCount = rows.length - okRows.length

    const ly = Math.floor((latest - 11) / 12), lm = (latest - 11) % 12
    const ey = Math.floor(latest / 12),        em = latest % 12
    const ttmLabel = `${MONTHS[lm]} ${ly} – ${MONTHS[em]} ${ey}`

    return { rows, portfolioRatio: totalSales > 0 ? totalCost / totalSales : 0, ttmLabel, insufficientCount }
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}

export { fmt }
