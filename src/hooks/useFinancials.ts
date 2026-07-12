import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'
import { fetchAllRows } from '../lib/fetchAll'

// PostgREST returns `numeric` columns as strings — coerce defensively.
export const num = (v: unknown): number => Number(v ?? 0)

export interface VendorSpend {
  vendor: string | null
  invoice_count: number
  total_spend: number
  first_invoice: string | null
  last_invoice: string | null
}

export interface GlAccount {
  account_code: string
  account_name: string | null
  total_debit: number
  total_credit: number
  net: number
  txn_count: number
  first_date: string | null
  last_date: string | null
}

export interface DuplicateFlag {
  vendor: string | null
  invoice_total: number
  invoice_date: string | null
  occurrences: number
  invoice_numbers: string[]
  invoice_ids: string[]
}

export interface AccountInvoice {
  invoice_id: string
  vendor: string | null
  invoice_number: string | null
  invoice_date: string | null
  posting_date: string | null
  amount: number
  gl_account_code: string | null
  gl_account_desc: string | null
  memo: string | null
  image_url: string | null
  invoice_url: string | null
}

export interface GlTxn {
  entry_date: string | null
  period: string | null
  source_code: string | null
  reference: string | null
  description: string | null
  debit: number
  credit: number
  balance: number
}

// Rolling / calendar date windows shared by the Financials filters.
export type SpendWindow = '30d' | '60d' | '90d' | 'ytd' | 'ttm' | 'all'

export const SPEND_WINDOW_LABEL: Record<SpendWindow, string> = {
  '30d': 'Past 30 days', '60d': 'Past 60 days', '90d': 'Past 90 days',
  ytd: 'Year to date', ttm: 'Trailing 12 months', all: 'Since acquisition',
}
export const SPEND_WINDOW_SHORT: Record<SpendWindow, string> = {
  '30d': '30d', '60d': '60d', '90d': '90d', ytd: 'YTD', ttm: 'TTM', all: 'All',
}

// Cutoff date (inclusive) for a window, as an ISO yyyy-mm-dd string; null = all time.
export function windowSince(w: SpendWindow, now = new Date()): string | null {
  if (w === 'all') return null
  const d = new Date(now)
  if (w === 'ytd') return `${now.getFullYear()}-01-01`
  if (w === 'ttm') d.setFullYear(d.getFullYear() - 1)
  else d.setDate(d.getDate() - Number(w.replace('d', '')))
  return d.toISOString().slice(0, 10)
}

export function useVendorSpend(propertyId: string | null, window: SpendWindow = '90d') {
  return useQuery<VendorSpend[]>(async () => {
    if (!propertyId) return []
    const { data, error } = await supabase
      .rpc('vendor_spend_window', { p_property: propertyId, p_since: windowSince(window) })
      .limit(20)
    if (error) throw new Error(error.message)
    return (data ?? []).map((r: any) => ({
      vendor: r.vendor, first_invoice: r.first_invoice, last_invoice: r.last_invoice,
      total_spend: num(r.total_spend), invoice_count: num(r.invoice_count),
    })) as VendorSpend[]
  }, [propertyId, window])
}

export function useGlAccounts(propertyId: string | null) {
  return useQuery<GlAccount[]>(async () => {
    if (!propertyId) return []
    const { data, error } = await supabase
      .from('v_gl_account_summary')
      .select('account_code, account_name, total_debit, total_credit, net, txn_count, first_date, last_date')
      .eq('property_id', propertyId)
      .order('account_code')
    if (error) throw new Error(error.message)
    return (data ?? []).map(r => ({
      ...r,
      total_debit: num(r.total_debit), total_credit: num(r.total_credit),
      net: num(r.net), txn_count: num(r.txn_count),
    })) as GlAccount[]
  }, [propertyId])
}

export function useDuplicateFlags(propertyId: string | null) {
  return useQuery<DuplicateFlag[]>(async () => {
    if (!propertyId) return []
    const { data, error } = await supabase
      .from('v_possible_duplicate_invoices')
      .select('vendor, invoice_total, invoice_date, occurrences, invoice_numbers, invoice_ids')
      .eq('property_id', propertyId)
      .order('invoice_total', { ascending: false })
    if (error) throw new Error(error.message)
    return (data ?? []).map(r => ({ ...r, invoice_total: num(r.invoice_total), occurrences: num(r.occurrences) })) as DuplicateFlag[]
  }, [propertyId])
}

// ── Duplicate-flag dismissals (invoice_dup_dismissals, migration 20240035) ──
// A flag's key is its sorted invoice-id set — if a NEW invoice later joins the
// same vendor/amount/date group, the key changes and the flag re-surfaces.
export const dupFlagKey = (flag: DuplicateFlag) => [...(flag.invoice_ids ?? [])].sort().join('|')

export function useDupDismissals(propertyId: string | null) {
  return useQuery<Set<string>>(async () => {
    if (!propertyId) return new Set()
    const { data, error } = await supabase
      .from('invoice_dup_dismissals')
      .select('flag_key')
      .eq('property_id', propertyId)
    if (error) throw new Error(error.message)
    return new Set(((data ?? []) as any[]).map(r => r.flag_key as string))
  }, [propertyId])
}

export async function dismissDupFlag(propertyId: string, flag: DuplicateFlag, dismissedBy: string | null): Promise<void> {
  const { error } = await supabase
    .from('invoice_dup_dismissals')
    .upsert({ property_id: propertyId, flag_key: dupFlagKey(flag), dismissed_by: dismissedBy }, { onConflict: 'property_id,flag_key' })
  if (error) throw new Error(error.message)
}

export async function restoreDupFlag(propertyId: string, flag: DuplicateFlag): Promise<void> {
  const { error } = await supabase
    .from('invoice_dup_dismissals')
    .delete()
    .eq('property_id', propertyId)
    .eq('flag_key', dupFlagKey(flag))
  if (error) throw new Error(error.message)
}

// Vendor spend across MANY properties (dashboard) — aggregates a vendor that
// appears under more than one entity into a single row. 'ttm' reads the
// trailing-12-month view; 'all' reads spend since acquisition.
export type VendorWindow = 'ttm' | 'all'

export function useVendorSpendMulti(propertyIds: string[], window: VendorWindow = 'ttm') {
  return useQuery<VendorSpend[]>(async () => {
    if (!propertyIds.length) return []
    const { data, error } = await supabase
      .from(window === 'ttm' ? 'v_vendor_spend_ttm' : 'v_vendor_spend')
      .select('vendor, invoice_count, total_spend')
      .in('property_id', propertyIds)
    if (error) throw new Error(error.message)
    const byVendor = new Map<string, VendorSpend>()
    for (const r of (data ?? []) as any[]) {
      const key = r.vendor ?? '—'
      const prev = byVendor.get(key)
      if (prev) { prev.total_spend += num(r.total_spend); prev.invoice_count += num(r.invoice_count) }
      else byVendor.set(key, { vendor: r.vendor, invoice_count: num(r.invoice_count), total_spend: num(r.total_spend), first_invoice: null, last_invoice: null })
    }
    return [...byVendor.values()].sort((a, b) => b.total_spend - a.total_spend).slice(0, 12)
  }, [propertyIds.join(','), window])
}

// Count of indexed documents in the corpus (every row is chunked + embedded).
export function useDocCorpusCount() {
  return useQuery<number>(async () => {
    const { count, error } = await supabase
      .from('documents')
      .select('*', { count: 'exact', head: true })
    if (error) throw new Error(error.message)
    return count ?? 0
  }, [])
}

// On-demand drill-down: invoices behind a GL account + the GL transactions themselves.
// Paged: the RPCs return up to ~23k rows for the busiest accounts and PostgREST
// caps each response at 1,000. Both functions ORDER BY with a unique tiebreaker.
// Optional year/month scope the drill-down to an accounting period (RPC-side).
export async function fetchAccountInvoices(propertyId: string, accountCode: string, year?: number, month?: number): Promise<AccountInvoice[]> {
  const rows = await fetchAllRows<AccountInvoice>((from, to) => supabase
    .rpc('account_invoices', { p_property: propertyId, p_account_code: accountCode, p_year: year ?? null, p_month: month ?? null })
    .range(from, to))
  return rows.map(r => ({ ...r, amount: num(r.amount) }))
}

export async function fetchGlTransactions(propertyId: string, accountCode: string, year?: number, month?: number): Promise<GlTxn[]> {
  const rows = await fetchAllRows<GlTxn>((from, to) => supabase
    .rpc('gl_transactions', { p_property: propertyId, p_account_code: accountCode, p_year: year ?? null, p_month: month ?? null })
    .range(from, to))
  return rows.map(r => ({ ...r, debit: num(r.debit), credit: num(r.credit), balance: num(r.balance) }))
}

// Invoice detail for a duplicate-payment flag (ids come from the view).
export interface FlagInvoice {
  id: string
  invoice_number: string | null
  invoice_date: string | null
  posting_date: string | null
  invoice_total: number
  memo: string | null
  image_url: string | null
  invoice_url: string | null
}

export async function fetchInvoicesByIds(ids: string[]): Promise<FlagInvoice[]> {
  if (!ids.length) return []
  const { data, error } = await supabase
    .from('invoices')
    .select('id, invoice_number, invoice_date, posting_date, invoice_total, memo, image_url, invoice_url')
    .in('id', ids)
    .order('posting_date')
  if (error) throw new Error(error.message)
  return (data ?? []).map((r: any) => ({ ...r, invoice_total: num(r.invoice_total) }))
}

// ── Financial statements (GL-derived) ────────────────────────────────────────

export const STMT_CAT_LABEL: Record<string, string> = {
  base_rent: 'Base Rent', percentage_rent: 'Percentage Rent', cam_recovery: 'Recoveries',
  other_income: 'Other Income', taxes: 'Real Estate Taxes', insurance: 'Insurance',
  utilities: 'Utilities', repairs_maintenance: 'Repairs & Maintenance',
  operating_expenses: 'Contract Services', management_fee: 'Management Fee',
  other_expense: 'G&A / Marketing',
  below_line: 'Below-NOI (interest, depreciation, leasing, owner costs)',
}
const STMT_INCOME_ORDER  = ['base_rent', 'percentage_rent', 'cam_recovery', 'other_income']
const STMT_EXPENSE_ORDER = ['taxes', 'insurance', 'utilities', 'repairs_maintenance', 'operating_expenses', 'management_fee', 'other_expense']

export interface StatementLine {
  category: string; label: string
  mtd: number; ytd: number; ttm: number
  budMtd?: number | null; budYtd?: number | null   // approved budget, when loaded
}
export interface IncomeStatementData {
  latest: { year: number; month: number } | null      // the statement period shown
  months: Array<{ year: number; month: number }>      // all GL months, newest first
  hasBudget: boolean
  income: StatementLine[]
  expense: StatementLine[]
  revenue: StatementLine
  opex: StatementLine
  noi: StatementLine
  belowNoi: StatementLine
  netIncome: StatementLine
}

// MTD / YTD / TTM income statement from the GL category matview.
// `asOf` selects the statement month (e.g. "January 2026"); default = latest.
export function useIncomeStatement(propertyId: string | null, asOf?: { year: number; month: number } | null) {
  return useQuery<IncomeStatementData | null>(async () => {
    if (!propertyId) return null

    // All GL months for this property (newest first) — feeds the month picker.
    const monthRows = await fetchAllRows<any>((from, to) => supabase
      .from('v_gl_pnl_monthly')
      .select('period_year, period_month')
      .eq('property_id', propertyId)
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false })
      .range(from, to))
    if (!monthRows.length) return null
    const months = monthRows.map(r => ({ year: num(r.period_year), month: num(r.period_month) }))
    const latest = (asOf && months.some(m => m.year === asOf.year && m.month === asOf.month))
      ? asOf
      : months[0]
    const latestKey = latest.year * 12 + latest.month

    const rows = await fetchAllRows<any>((from, to) => supabase
      .from('v_gl_pnl_category')
      .select('period_year, period_month, line_type, category, amount')
      .eq('property_id', propertyId)
      .gte('period_year', latest.year - 1)
      .order('period_year').order('period_month').order('line_type').order('category')
      .range(from, to))

    // Approved budget for the statement year (category x month; small set).
    const { data: budRows, error: bErr } = await supabase
      .from('v_budget_pnl_category')
      .select('period_month, line_type, category, amount')
      .eq('property_id', propertyId)
      .eq('period_year', latest.year)
    if (bErr) throw new Error(bErr.message)
    const bud = new Map<string, { mtd: number; ytd: number }>()
    for (const r of (budRows ?? []) as any[]) {
      const key = `${r.line_type}|${r.category}`
      const cur = bud.get(key) ?? { mtd: 0, ytd: 0 }
      const amt = num(r.amount)
      if (num(r.period_month) === latest.month) cur.mtd += amt
      if (num(r.period_month) <= latest.month) cur.ytd += amt
      bud.set(key, cur)
    }
    const hasBudget = bud.size > 0

    const mk = () => new Map<string, { mtd: number; ytd: number; ttm: number }>()
    const acc = { revenue: mk(), opex: mk(), below_line: mk() }
    for (const r of rows) {
      const key = num(r.period_year) * 12 + num(r.period_month)
      const bucket = acc[r.line_type as keyof typeof acc]
      if (!bucket) continue
      const cur = bucket.get(r.category) ?? { mtd: 0, ytd: 0, ttm: 0 }
      const amt = num(r.amount)
      if (key === latestKey) cur.mtd += amt
      if (num(r.period_year) === latest.year && key <= latestKey) cur.ytd += amt
      if (key > latestKey - 12 && key <= latestKey) cur.ttm += amt
      bucket.set(r.category, cur)
    }

    const line = (category: string, m: Map<string, { mtd: number; ytd: number; ttm: number }>, lineType: string): StatementLine => {
      const v = m.get(category) ?? { mtd: 0, ytd: 0, ttm: 0 }
      const b = bud.get(`${lineType}|${category}`)
      return { category, label: STMT_CAT_LABEL[category] ?? category, ...v,
        budMtd: b ? b.mtd : hasBudget ? 0 : null, budYtd: b ? b.ytd : hasBudget ? 0 : null }
    }
    const sum = (lines: StatementLine[], label: string): StatementLine => ({
      category: label, label,
      mtd: lines.reduce((s, l) => s + l.mtd, 0),
      ytd: lines.reduce((s, l) => s + l.ytd, 0),
      ttm: lines.reduce((s, l) => s + l.ttm, 0),
      budMtd: hasBudget ? lines.reduce((s, l) => s + (l.budMtd ?? 0), 0) : null,
      budYtd: hasBudget ? lines.reduce((s, l) => s + (l.budYtd ?? 0), 0) : null,
    })

    // Include categories present in EITHER actuals or budget so budget-only
    // lines (e.g. budgeted percentage rent) still show.
    const hasCat = (m: Map<string, any>, lt: string, c: string) => m.has(c) || bud.has(`${lt}|${c}`)
    const income  = STMT_INCOME_ORDER.filter(c => hasCat(acc.revenue, 'revenue', c)).map(c => line(c, acc.revenue, 'revenue'))
    const expense = STMT_EXPENSE_ORDER.filter(c => hasCat(acc.opex, 'opex', c)).map(c => line(c, acc.opex, 'opex'))
    const revenue = sum(income, 'Total Revenue')
    const opex    = sum(expense, 'Total Operating Expenses')
    const noi: StatementLine = { category: 'noi', label: 'Net Operating Income',
      mtd: revenue.mtd - opex.mtd, ytd: revenue.ytd - opex.ytd, ttm: revenue.ttm - opex.ttm,
      budMtd: hasBudget ? (revenue.budMtd ?? 0) - (opex.budMtd ?? 0) : null,
      budYtd: hasBudget ? (revenue.budYtd ?? 0) - (opex.budYtd ?? 0) : null }
    const belowParts = [...acc.below_line.keys()].map(c => line(c, acc.below_line, 'below_line'))
    const belowBud = bud.get('below_line|below_line')
    const belowNoi: StatementLine = { ...sum(belowParts, 'below'), category: 'below_line', label: STMT_CAT_LABEL.below_line,
      budMtd: hasBudget ? (belowBud?.mtd ?? 0) : null, budYtd: hasBudget ? (belowBud?.ytd ?? 0) : null }
    const netIncome: StatementLine = { category: 'net', label: 'Net Income (GL)',
      mtd: noi.mtd - belowNoi.mtd, ytd: noi.ytd - belowNoi.ytd, ttm: noi.ttm - belowNoi.ttm,
      budMtd: hasBudget ? (noi.budMtd ?? 0) - (belowNoi.budMtd ?? 0) : null,
      budYtd: hasBudget ? (noi.budYtd ?? 0) - (belowNoi.budYtd ?? 0) : null }

    return { latest, months, hasBudget, income, expense, revenue, opex, noi, belowNoi, netIncome }
  }, [propertyId, asOf ? asOf.year * 12 + asOf.month : 0])
}

// ── Recent documents (Financials panel) ──────────────────────────────────────
// Surfaces the property's most recently modified corpus documents so users don't
// have to bounce to the Documents panel. Ordered by file_mtime (the file-server
// modified time), which is the meaningful "new document" signal — upload_date is
// unset and created_at only reflects bulk-ingest time. Storage-mirrored PDFs get
// a short-lived signed URL that opens in the bundled viewer.
export interface RecentDoc {
  id: string
  title: string | null
  doc_type: string
  file_path: string | null
  storage_path: string | null
  file_mtime: string | null
  view_url: string | null
}

export function useRecentDocs(propertyId: string | null, window: SpendWindow = '30d', limit = 40) {
  return useQuery<RecentDoc[]>(async () => {
    if (!propertyId) return []
    const since = windowSince(window)
    let q = supabase
      .from('documents')
      .select('id, title, doc_type, file_path, storage_path, file_mtime')
      .eq('property_id', propertyId)
      .not('file_mtime', 'is', null)
      .order('file_mtime', { ascending: false })
      .limit(limit)
    if (since) q = q.gte('file_mtime', since)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as any[]

    // Batch-sign the storage-mirrored PDFs (1h) so each row can link straight in.
    const paths = rows.map(r => r.storage_path).filter((p): p is string => typeof p === 'string' && p.startsWith('p/'))
    const signed = new Map<string, string>()
    if (paths.length) {
      const { data: s } = await supabase.storage.from('documents').createSignedUrls(paths, 3600)
      for (const it of s ?? []) if (it.path && it.signedUrl) signed.set(it.path, it.signedUrl)
    }
    return rows.map(r => ({
      id: r.id, title: r.title, doc_type: r.doc_type, file_path: r.file_path,
      storage_path: r.storage_path, file_mtime: r.file_mtime,
      view_url: r.storage_path && signed.has(r.storage_path) ? signed.get(r.storage_path)! : null,
    }))
  }, [propertyId, window, limit])
}

export interface BsLine { account_code: string; account_name: string | null; balance: number }
export interface BalanceSheetData {
  assets: BsLine[]; liabilities: BsLine[]; equity: BsLine[]
  totalAssets: number; totalLiabilities: number; totalEquity: number
  currentEarnings: number   // A − L − E: cumulative unclosed P&L (plug)
}

// Balance sheet from cumulative GL balances (accounts 1xxx/2xxx/3xxx, incl.
// balance-forward rows). Liabilities/equity shown credit-positive.
export function useBalanceSheet(propertyId: string | null) {
  return useQuery<BalanceSheetData | null>(async () => {
    if (!propertyId) return null
    const rows = await fetchAllRows<any>((from, to) => supabase
      .from('v_gl_balance_sheet')
      .select('account_code, account_name, balance')
      .eq('property_id', propertyId)
      .order('account_code')
      .range(from, to))
    if (!rows.length) return null

    const assets: BsLine[] = [], liabilities: BsLine[] = [], equity: BsLine[] = []
    for (const r of rows) {
      const bal = num(r.balance)
      if (Math.abs(bal) < 0.005) continue
      const l: BsLine = { account_code: r.account_code, account_name: r.account_name, balance: bal }
      if (r.account_code.startsWith('1')) assets.push(l)
      else if (r.account_code.startsWith('2')) liabilities.push({ ...l, balance: -bal })
      else equity.push({ ...l, balance: -bal })
    }
    const totalAssets      = assets.reduce((s, l) => s + l.balance, 0)
    const totalLiabilities = liabilities.reduce((s, l) => s + l.balance, 0)
    const totalEquity      = equity.reduce((s, l) => s + l.balance, 0)
    return {
      assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity,
      currentEarnings: totalAssets - totalLiabilities - totalEquity,
    }
  }, [propertyId])
}
