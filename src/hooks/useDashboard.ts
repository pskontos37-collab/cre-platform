import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'
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
  headroom: number | null
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

    // Batch-fetch all periods + items for all relevant properties
    const oneYearAgo = new Date()
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1)

    const { data: periods } = await supabase
      .from('financial_periods')
      .select('id, property_id, period_start, is_budget')
      .in('property_id', propertyIds)
      .eq('is_budget', false)
      .gte('period_start', oneYearAgo.toISOString().split('T')[0])
      .order('period_start', { ascending: true })

    const { data: items } = await supabase
      .from('operating_line_items')
      .select('financial_period_id, category, amount')
      .in('financial_period_id', (periods ?? []).map((p: any) => p.id))

    const periodsArr = (periods ?? []) as Pick<FinancialPeriod, 'id' | 'property_id' | 'period_start' | 'is_budget'>[]
    const itemsArr = (items ?? []) as Pick<OperatingLineItem, 'financial_period_id' | 'category' | 'amount'>[]

    return loansArr.map(loan => {
      const propPeriods = periodsArr.filter(p => p.property_id === loan.property_id)
      const t12Noi = propPeriods.length
        ? computeTrailing12NOI(propPeriods.map(p => ({
            isActual: !p.is_budget,
            lineItems: itemsArr.filter(i => i.financial_period_id === p.id),
          })))
        : null

      const dscr = loan.annual_debt_service && t12Noi !== null
        ? computeDSCR(t12Noi, loan.annual_debt_service) : null

      const headroomResult = dscr !== null && loan.dscr_covenant && loan.annual_debt_service && t12Noi !== null
        ? computeDSCRHeadroom(t12Noi, loan.annual_debt_service, loan.dscr_covenant)
        : null

      const debtYield = loan.outstanding_balance && loan.outstanding_balance > 0 && t12Noi !== null
        ? t12Noi / loan.outstanding_balance : null

      return {
        loan,
        propertyName: propertyNames[loan.property_id] ?? 'Unknown',
        t12Noi,
        dscr,
        debtYield,
        headroom:  headroomResult?.headroom ?? null,
        isNear:    headroomResult ? (!headroomResult.isBreach && (headroomResult.headroom ?? 0) < 0.10) : false,
        isBreach:  headroomResult?.isBreach ?? false,
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

export interface RolloverData {
  walt: number
  byYear: RolloverYear[]
  totalLeasedSf: number
}

export function useLeaseRollover(propertyIds: string[]) {
  return useQuery<RolloverData>(async () => {
    if (!propertyIds.length) return { walt: 0, byYear: [], totalLeasedSf: 0 }

    const { data: leases, error } = await supabase
      .from('leases')
      .select('id, leased_sf, expiration_date, status')
      .in('property_id', propertyIds)
      .eq('status', 'active')
      .not('expiration_date', 'is', null)

    if (error) throw new Error(error.message)
    const leasesArr = (leases ?? []) as { id: string; leased_sf: number | null; expiration_date: string; status: string }[]

    const today = new Date()
    const active = leasesArr.filter(l => new Date(l.expiration_date) > today)

    const yearMap = new Map<number, { sf: number; count: number }>()
    for (const l of active) {
      const year = new Date(l.expiration_date).getFullYear()
      const prev = yearMap.get(year) ?? { sf: 0, count: 0 }
      yearMap.set(year, { sf: prev.sf + (l.leased_sf ?? 0), count: prev.count + 1 })
    }

    const totalLeasedSf = active.reduce((s, l) => s + (l.leased_sf ?? 0), 0)

    const byYear = Array.from(yearMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([year, { sf, count }]) => ({
        year, sf, count,
        pctOfTotal: totalLeasedSf > 0 ? sf / totalLeasedSf : 0,
      }))

    const walt = computeWALT(
      active.map(l => ({ leasedSf: l.leased_sf ?? 0, expirationDate: l.expiration_date })),
      today,
    )

    return { walt, byYear, totalLeasedSf }
  }, [propertyIds.join(',')])
}

// ── Critical Dates ────────────────────────────────────────────────────────────

export interface CriticalDateRow {
  id: string
  propertyName: string
  tenantName: string | null
  dateType: string
  dueDate: string
  description: string | null
  daysUntil: number
  loanId: string | null
  leaseId: string | null
}

export function useCriticalDates(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<CriticalDateRow[]>(async () => {
    if (!propertyIds.length) return []

    const today = new Date()
    const horizon = new Date()
    horizon.setDate(horizon.getDate() + 90)

    const { data, error } = await supabase
      .from('critical_dates')
      .select('id, property_id, lease_id, loan_id, date_type, due_date, description')
      .in('property_id', propertyIds)
      .eq('is_completed', false)
      .gte('due_date', today.toISOString().split('T')[0])
      .lte('due_date', horizon.toISOString().split('T')[0])
      .order('due_date')
      .limit(20)

    if (error) throw new Error(error.message)

    return ((data ?? []) as any[]).map(row => ({
      id:           row.id,
      propertyName: propertyNames[row.property_id] ?? 'Unknown',
      tenantName:   null,
      dateType:     row.date_type,
      dueDate:      row.due_date,
      description:  row.description,
      daysUntil:    Math.ceil((new Date(row.due_date).getTime() - today.getTime()) / 86_400_000),
      loanId:       row.loan_id,
      leaseId:      row.lease_id,
    }))
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}

// ── Co-Tenancy Flags ──────────────────────────────────────────────────────────

export function useCoTenancyFlags(propertyIds: string[]) {
  return useQuery<CoTenancyFlag[]>(async () => {
    if (!propertyIds.length) return []

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
      .select('tenant_id, property_id, leased_sf, lease_rent_schedules(annual_rent, effective_date), tenant:tenants(id, name)')
      .in('property_id', propertyIds)
      .eq('status', 'active')

    if (error) throw new Error(error.message)

    const today = new Date()
    const tenantMap = new Map<string, { name: string; rent: number; sf: number; propId: string }>()

    for (const lease of (data ?? []) as any[]) {
      const schedules: any[] = (lease.lease_rent_schedules ?? [])
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

// ── Delinquency ───────────────────────────────────────────────────────────────

export interface DelinquencyRow {
  id: string
  tenantName: string
  propertyName: string
  unitNumber: string | null
  balance: number
  dueDate: string
  daysLate: number
  paymentType: string
}

export function useDelinquency(propertyIds: string[], propertyNames: Record<string, string>) {
  return useQuery<DelinquencyRow[]>(async () => {
    if (!propertyIds.length) return []

    const today = new Date().toISOString().split('T')[0]

    const { data, error } = await supabase
      .from('lease_payments')
      .select('id, property_id, amount_due, amount_paid, due_date, payment_type, tenant:tenants(name), lease:leases(unit_id)')
      .in('property_id', propertyIds)
      .lt('due_date', today)
      .is('paid_date', null)
      .order('due_date')

    if (error) throw new Error(error.message)

    const todayMs = Date.now()
    return ((data ?? []) as any[]).map(row => ({
      id:           row.id,
      tenantName:   row.tenant?.name ?? 'Unknown',
      propertyName: propertyNames[row.property_id] ?? 'Unknown',
      unitNumber:   null,
      balance:      row.amount_due - row.amount_paid,
      dueDate:      row.due_date,
      daysLate:     Math.floor((todayMs - new Date(row.due_date).getTime()) / 86_400_000),
      paymentType:  row.payment_type,
    }))
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}

// ── CAM Reconciliation ────────────────────────────────────────────────────────

export interface CAMReconRow {
  id: string
  propertyName: string
  tenantName: string | null
  periodYear: number
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
      .select('id, property_id, period_year, estimated_amount, actual_amount, status, due_date, tenant:tenants(name)')
      .in('property_id', propertyIds)
      .neq('status', 'complete')
      .order('due_date', { nullsFirst: false })
      .limit(20)

    if (error) throw new Error(error.message)

    return ((data ?? []) as any[]).map(row => ({
      id:               row.id,
      propertyName:     propertyNames[row.property_id] ?? 'Unknown',
      tenantName:       row.tenant?.name ?? null,
      periodYear:       row.period_year,
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
      salesByLease[rec.lease_id] = (salesByLease[rec.lease_id] ?? 0) + rec.reported_sales
    }

    return (leases as any[]).map(lease => {
      const ytdSales = salesByLease[lease.id] ?? 0
      const bp = lease.natural_breakpoint ?? lease.artificial_breakpoint ?? 0
      const pctToBreakpoint = bp > 0 ? Math.min(ytdSales / bp, 1) : 0
      const rate = lease.percentage_rent_rate ?? 0
      const excess = Math.max(ytdSales - bp, 0)

      return {
        leaseId:          lease.id,
        tenantName:       lease.tenant?.name ?? 'Unknown',
        propertyName:     propertyNames[lease.property_id] ?? 'Unknown',
        ytdSales,
        effectiveBreakpoint: bp,
        pctRate:          lease.percentage_rent_rate,
        pctToBreakpoint,
        estimatedPctRent: excess * rate,
        willTrigger:      ytdSales > bp,
      }
    })
  }, [propertyIds.join(','), JSON.stringify(propertyNames)])
}

export { fmt }
