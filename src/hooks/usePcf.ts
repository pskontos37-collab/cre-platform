import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'
import { fetchAllRows } from '../lib/fetchAll'

// Projected Cash Flow for OWNED properties (migs 20240133-38). This is NOT the
// acquisition-target cash flow that lives under /pipeline - different project,
// different tables.
//
// The screen is one grid per property-fiscal-year split by a MOVING BOUNDARY:
// months <= as_of_month are closed and read from the GL, months after it are
// editable forecast. Month-end moves the boundary one column right.
//
// Interaction rules the user set (2026-07-27), which this hook implements
// literally:
//   1. ANALYST DRIVES, APP DOES ARITHMETIC. Forward months seed once at version
//      creation and then stay put. Nothing here re-derives a forward number on
//      its own, and closing a month never re-forecasts the months after it.
//   2. CASH BASIS IS PER-PROPERTY. bank_balance opens at a real balance;
//      cumulative opens at 0 and tracks cash generated. Never add them together.
//   3. IMMUTABLE MONTHLY SNAPSHOT. Publishing freezes a version - the database
//      enforces it, this hook only keeps the UI honest about it.

export type PcfSection = 'income' | 'opex' | 'non_operating' | 'capital' | 'balance_sheet' | 'equity'
export type CashBasis = 'bank_balance' | 'cumulative'
export type CellMethod = 'actual' | 'budget' | 'manual' | 'derived_schedule' | 'carried'

export interface PcfVersion {
  id: string
  property_id: string
  fiscal_year: number
  as_of_month: number
  status: 'draft' | 'published'
  cash_basis: CashBasis | null
  opening_cash: number | null
  published_at: string | null
  created_at: string
}

export interface PcfCell {
  month: number
  isActual: boolean
  amount: number | null      // null = genuinely unset. NEVER coerce to 0 - see note below.
  method: CellMethod | null
  note: string | null
  derivedFromYear: number | null
}

export interface PcfRow {
  lineKey: string
  section: PcfSection
  subsection: string | null
  label: string
  sortOrder: number
  isNonCash: boolean
  hasBudgetSeed: boolean
  cells: PcfCell[]           // always 12, index 0 = January
  fyTotal: number
}

export interface PcfGrid {
  rows: PcfRow[]
  asOfMonth: number
  fiscalYear: number
  propertyId: string
}

const MONTHS = 12
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))

// A blank cell must stay blank all the way to the screen. A silent zero in the
// bridge is how a cash flow quietly stops tying, so `amount` is nullable and the
// UI renders an em dash rather than 0.00 for an unset forward month.
function emptyCells(): PcfCell[] {
  return Array.from({ length: MONTHS }, (_, i) => ({
    month: i + 1, isActual: false, amount: null, method: null, note: null, derivedFromYear: null,
  }))
}

export function usePcfVersions(propertyId: string | null) {
  return useQuery<PcfVersion[]>(async () => {
    if (!propertyId) return []
    const { data, error } = await supabase
      .from('pcf_versions')
      .select('id, property_id, fiscal_year, as_of_month, status, cash_basis, opening_cash, published_at, created_at')
      .eq('property_id', propertyId)
      .order('fiscal_year', { ascending: false })
      .order('as_of_month', { ascending: false })
    if (error) throw new Error(error.message)
    return (data ?? []) as PcfVersion[]
  }, [propertyId])
}

export function usePcfGrid(versionId: string | null) {
  return useQuery<PcfGrid | null>(async () => {
    if (!versionId) return null

    // pcf_grid() the FUNCTION, not v_pcf_grid the view. The view could not push the
    // version's property/year down into the GL, so it seq-scanned gl_entries three times
    // and 500'd on a statement timeout under RLS. The function reads the version first;
    // same output, ~9x faster (mig 20240141).
    //
    // Still paged: db-max-rows caps RPC responses too, and Magnolia (1,032) and Gateway
    // (1,020) both exceed 1,000. Unpaged, they would silently lose the tail of the grid -
    // the equity lines that feed Net cash.
    const rows = await fetchAllRows<any>((from, to) => supabase
      .rpc('pcf_grid', { p_version_id: versionId })
      .select('property_id, fiscal_year, line_key, section, subsection, label, sort_order, is_non_cash, period_month, is_actual, amount, method, note, derived_from_year, has_budget_seed')
      .order('sort_order').order('line_key').order('period_month')
      .range(from, to))

    if (!rows.length) return null

    const byLine = new Map<string, PcfRow>()
    let asOfMonth = 0
    for (const r of rows) {
      let row = byLine.get(r.line_key)
      if (!row) {
        row = {
          lineKey: r.line_key,
          section: r.section as PcfSection,
          subsection: r.subsection ?? null,
          label: r.label,
          sortOrder: Number(r.sort_order),
          isNonCash: Boolean(r.is_non_cash),
          hasBudgetSeed: Boolean(r.has_budget_seed),
          cells: emptyCells(),
          fyTotal: 0,
        }
        byLine.set(r.line_key, row)
      }
      const m = Number(r.period_month)
      const amount = r.amount === null || r.amount === undefined ? null : Number(r.amount)
      row.cells[m - 1] = {
        month: m,
        isActual: Boolean(r.is_actual),
        amount,
        method: (r.method ?? null) as CellMethod | null,
        note: r.note ?? null,
        derivedFromYear: r.derived_from_year === null || r.derived_from_year === undefined ? null : Number(r.derived_from_year),
      }
      if (r.is_actual && m > asOfMonth) asOfMonth = m
    }

    const out = [...byLine.values()]
    for (const row of out) row.fyTotal = row.cells.reduce((s, c) => s + num(c.amount), 0)
    out.sort((a, b) => a.sortOrder - b.sortOrder || a.lineKey.localeCompare(b.lineKey))

    return { rows: out, asOfMonth, fiscalYear: Number(rows[0].fiscal_year), propertyId: rows[0].property_id }
  }, [versionId])
}

// ---------------------------------------------------------------------------
// The cascade. Every stored amount is already its EFFECT ON CASH (mig 20240133),
// so every subtotal below is a plain SUM - that is deliberate, and it is what
// structurally kills the sign-error class found in the reference workbook.
// ---------------------------------------------------------------------------
export interface PcfTotals {
  totalIncome: number[]
  totalOpex: number[]
  noi: number[]
  nonOperating: number[]
  netIncome: number[]
  capital: number[]
  balanceSheet: number[]
  netMonthlyCash: number[]
  equity: number[]
  netCash: number[]
  beginningCash: number[]
  endingCash: number[]
}

const zeros = () => Array.from({ length: MONTHS }, () => 0)

function sumSection(rows: PcfRow[], section: PcfSection, opts?: { cashOnly?: boolean }): number[] {
  const out = zeros()
  for (const r of rows) {
    if (r.section !== section) continue
    if (opts?.cashOnly && r.isNonCash) continue
    for (let i = 0; i < MONTHS; i++) out[i] += num(r.cells[i].amount)
  }
  return out
}

const addAll = (...series: number[][]): number[] =>
  series.reduce((acc, s) => acc.map((v, i) => v + s[i]), zeros())

export function computeTotals(rows: PcfRow[], openingCash: number): PcfTotals {
  const totalIncome  = sumSection(rows, 'income')
  const totalOpex    = sumSection(rows, 'opex')
  const noi          = addAll(totalIncome, totalOpex)
  const nonOperating = sumSection(rows, 'non_operating')
  const netIncome    = addAll(noi, nonOperating)

  // The bridge excludes is_non_cash lines. They stay inside net income so the
  // statement ties to the property's own P&L, but they never move cash - and
  // they must be excluded in MATCHED PAIRS (mig 20240135 RULE 3), which the
  // is_non_cash flag already encodes on both halves.
  const incomeCash  = sumSection(rows, 'income', { cashOnly: true })
  const opexCash    = sumSection(rows, 'opex', { cashOnly: true })
  const nonOpCash   = sumSection(rows, 'non_operating', { cashOnly: true })
  const capital     = sumSection(rows, 'capital', { cashOnly: true })
  const balanceSheet = sumSection(rows, 'balance_sheet', { cashOnly: true })
  const equity      = sumSection(rows, 'equity', { cashOnly: true })

  const netMonthlyCash = addAll(incomeCash, opexCash, nonOpCash, capital, balanceSheet)
  const netCash        = addAll(netMonthlyCash, equity)

  const beginningCash = zeros()
  const endingCash    = zeros()
  let running = openingCash
  for (let i = 0; i < MONTHS; i++) {
    beginningCash[i] = running
    running += netCash[i]
    endingCash[i] = running
  }

  return {
    totalIncome, totalOpex, noi, nonOperating, netIncome,
    capital, balanceSheet, netMonthlyCash, equity, netCash,
    beginningCash, endingCash,
  }
}

// ---------------------------------------------------------------------------
// Drill-down: what is actually behind a line, so a forward month can be filled
// from evidence rather than from a label.
// ---------------------------------------------------------------------------
export interface LineAccount { accountCode: string; accountName: string; cashEffect: number }
export interface LineHistoryPoint { year: number; month: number; amount: number }
export interface LineDetail {
  accounts: LineAccount[]
  history: LineHistoryPoint[]   // ascending, trailing 24 months
}

export function useLineDetail(propertyId: string | null, lineKey: string | null, throughYear: number) {
  return useQuery<LineDetail | null>(async () => {
    if (!propertyId || !lineKey) return null

    const rows = await fetchAllRows<any>((from, to) => supabase
      .from('v_pcf_gl_lines')
      .select('account_code, account_name, period_year, period_month, amount')
      .eq('property_id', propertyId)
      .eq('line_key', lineKey)
      .gte('period_year', throughYear - 2)
      .order('period_year').order('period_month').order('account_code')
      .range(from, to))

    const acctMap = new Map<string, LineAccount>()
    const histMap = new Map<number, LineHistoryPoint>()
    for (const r of rows) {
      const code = r.account_code as string
      const prev = acctMap.get(code)
      acctMap.set(code, {
        accountCode: code,
        accountName: r.account_name ?? code,
        cashEffect: (prev?.cashEffect ?? 0) + num(r.amount),
      })
      const y = Number(r.period_year), m = Number(r.period_month)
      const key = y * 12 + m
      const p = histMap.get(key) ?? { year: y, month: m, amount: 0 }
      p.amount += num(r.amount)
      histMap.set(key, p)
    }

    const history = [...histMap.values()]
      .sort((a, b) => (a.year * 12 + a.month) - (b.year * 12 + b.month))
      .slice(-24)
    const accounts = [...acctMap.values()]
      .sort((a, b) => Math.abs(b.cashEffect) - Math.abs(a.cashEffect))

    return { accounts, history }
  }, [propertyId, lineKey, throughYear])
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// Creating a version seeds BOTH sources, which is the whole of decision (1) plus
// the balance-sheet carve-out:
//   * judgment sections (income / opex / capital / non_operating) <- the approved
//     budget, then they stay put
//   * balance_sheet + equity <- v_pcf_bs_schedule_proposal, because MRI
//     BF_PROFORMD budgets carry no A/R, payable, escrow or distribution lines and
//     that is precisely the accrual->cash bridge
// A line with neither source is left genuinely blank, and the grid says so.
export async function createPcfVersion(
  propertyId: string,
  fiscalYear: number,
  asOfMonth: number,
  cashBasis: CashBasis | null,
): Promise<string> {
  const { data: ver, error: verErr } = await supabase
    .from('pcf_versions')
    .insert({ property_id: propertyId, fiscal_year: fiscalYear, as_of_month: asOfMonth, status: 'draft', cash_basis: cashBasis })
    .select('id')
    .single()
  if (verErr) throw new Error(verErr.message)
  const versionId = (ver as { id: string }).id

  const seeds: Array<{ version_id: string; line_key: string; period_month: number; amount: number; method: string; derived_from_year?: number }> = []

  const budget = await fetchAllRows<any>((from, to) => supabase
    .from('v_pcf_budget_lines')
    .select('line_key, section, period_month, amount')
    .eq('property_id', propertyId)
    .eq('period_year', fiscalYear)
    .order('line_key').order('period_month')
    .range(from, to))

  const budgetAgg = new Map<string, number>()
  for (const b of budget) {
    const section = b.section as string
    if (section === 'balance_sheet' || section === 'equity' || section === 'cash') continue
    const m = Number(b.period_month)
    if (!m || m <= asOfMonth) continue
    const key = `${b.line_key}|${m}`
    budgetAgg.set(key, (budgetAgg.get(key) ?? 0) + num(b.amount))
  }
  for (const [key, amount] of budgetAgg) {
    const [line_key, m] = key.split('|')
    seeds.push({ version_id: versionId, line_key, period_month: Number(m), amount, method: 'budget' })
  }

  const schedule = await fetchAllRows<any>((from, to) => supabase
    .from('v_pcf_bs_schedule_proposal')
    .select('line_key, period_month, amount, derived_from_year')
    .eq('property_id', propertyId)
    .order('line_key').order('period_month')
    .range(from, to))

  for (const s of schedule) {
    const m = Number(s.period_month)
    if (m <= asOfMonth) continue
    seeds.push({
      version_id: versionId, line_key: s.line_key, period_month: m,
      amount: num(s.amount), method: 'derived_schedule',
      derived_from_year: s.derived_from_year === null ? undefined : Number(s.derived_from_year),
    })
  }

  for (let i = 0; i < seeds.length; i += 500) {
    const { error } = await supabase.from('pcf_forecast_cells').insert(seeds.slice(i, i + 500))
    if (error) throw new Error(error.message)
  }

  return versionId
}

// Which month is actually closed is a FACT from the GL, not a judgment call, so
// it is derived rather than typed. Returns 0 when the year has no postings yet.
export async function latestClosedMonth(propertyId: string, fiscalYear: number): Promise<number> {
  const { data, error } = await supabase
    .from('v_pcf_gl_lines')
    .select('period_month')
    .eq('property_id', propertyId)
    .eq('period_year', fiscalYear)
    .order('period_month', { ascending: false })
    .limit(1)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<{ period_month: number }>
  return rows.length ? Number(rows[0].period_month) : 0
}

// Clearing a cell DELETES it rather than writing 0. An unset forward month must
// stay unset all the way down: a zero would silently enter the bridge and the
// cash flow would stop tying without anything looking wrong.
export async function clearPcfCell(versionId: string, lineKey: string, month: number): Promise<void> {
  const { error } = await supabase
    .from('pcf_forecast_cells')
    .delete()
    .eq('version_id', versionId)
    .eq('line_key', lineKey)
    .eq('period_month', month)
  if (error) throw new Error(error.message)
}

// An analyst override. Always method='manual' - the point of the method column is
// that you can see at a glance which numbers a person actually chose.
export async function savePcfCell(
  versionId: string,
  lineKey: string,
  month: number,
  amount: number,
  note: string | null,
  authorId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('pcf_forecast_cells')
    .upsert({
      version_id: versionId, line_key: lineKey, period_month: month,
      amount, method: 'manual', note, author_id: authorId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'version_id,line_key,period_month' })
  if (error) throw new Error(error.message)
}

export async function publishPcfVersion(
  versionId: string,
  cashBasis: CashBasis,
  openingCash: number | null,
  userId: string | null,
): Promise<void> {
  // bank_balance without an opening balance makes "ending cash" meaningless, so
  // the database rejects it too - this is the friendly half of the same rule.
  if (cashBasis === 'bank_balance' && (openingCash === null || Number.isNaN(openingCash))) {
    throw new Error('A bank-balance PCF needs an opening cash balance before it can be published.')
  }
  const { error } = await supabase
    .from('pcf_versions')
    .update({
      status: 'published',
      cash_basis: cashBasis,
      opening_cash: cashBasis === 'cumulative' ? 0 : openingCash,
      published_at: new Date().toISOString(),
      published_by: userId,
    })
    .eq('id', versionId)
  if (error) throw new Error(error.message)
}
