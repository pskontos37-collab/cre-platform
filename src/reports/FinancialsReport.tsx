import { Text, View, pdf } from '@react-pdf/renderer'
import type { IncomeStatementData, BalanceSheetData, StatementLine, VendorSpend } from '../hooks/useFinancials'
import { ReportShell, SectionLabel } from './ReportShell'
import { GREEN, RULE, SERIF, TEXT, TEXT_FAINT, TEXT_MUTED, WILKOW, fmt, pdfSafe } from './theme'

const MON3 = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export interface FinancialsReportInput {
  propertyName: string
  stmt: IncomeStatementData | null
  bs: BalanceSheetData | null
  vendors: VendorSpend[] | null
  vendorWindowLabel: string
  generatedAt: string
}

export async function buildFinancialsPdf(input: FinancialsReportInput): Promise<Blob> {
  return pdf(<FinancialsReport {...input} />).toBlob()
}

const periodLabel = (p: { year: number; month: number } | null) => (p ? `${MON3[p.month]} ${p.year}` : '—')

// portrait letter, 540pt usable
export function FinancialsReport({ propertyName, stmt, bs, vendors, vendorWindowLabel, generatedAt }: FinancialsReportInput) {
  const hasBud = !!stmt?.hasBudget
  const period = stmt?.latest ?? null

  return (
    <ReportShell
      kicker="M&J Wilkow · Portfolio Financials"
      title={pdfSafe(propertyName)}
      subtitle={`GL-derived financial statements${period ? ` · statement month ${periodLabel(period)}` : ''}`}
      metaRight={[`Generated ${generatedAt}`]}
      orientation="portrait"
    >
      {/* ── KPI band ── */}
      <View style={{ flexDirection: 'row', marginBottom: 16 }}>
        <Kpi label={`Revenue · YTD ${period?.year ?? ''}`} value={stmt ? fmt(stmt.revenue.ytd) : '—'} accent={WILKOW} />
        <Kpi label={`NOI · YTD ${period?.year ?? ''}`} value={stmt ? fmt(stmt.noi.ytd) : '—'} accent={GREEN} />
        <Kpi label="NOI · TTM" value={stmt ? fmt(stmt.noi.ttm) : '—'} accent={GREEN} />
        <Kpi label="Total Assets" value={bs ? fmt(bs.totalAssets) : '—'} accent={WILKOW} last />
      </View>

      {/* ── Income statement ── */}
      <SectionLabel>Income Statement</SectionLabel>
      {stmt ? (
        <View style={{ marginBottom: 16 }}>
          <StmtHeaderRow hasBud={hasBud} period={periodLabel(period)} year={period?.year ?? null} />
          <SubHead>Income</SubHead>
          {stmt.income.map(l => <StmtRow key={l.category} line={l} hasBud={hasBud} indent />)}
          <StmtRow line={stmt.revenue} hasBud={hasBud} bold rule />
          <SubHead>Operating Expenses</SubHead>
          {stmt.expense.map(l => <StmtRow key={l.category} line={l} hasBud={hasBud} indent negative />)}
          <StmtRow line={stmt.opex} hasBud={hasBud} bold negative rule />
          <StmtRow line={stmt.noi} hasBud={hasBud} bold accent rule />
          <StmtRow line={stmt.belowNoi} hasBud={hasBud} indent negative muted />
          <StmtRow line={stmt.netIncome} hasBud={hasBud} bold rule />
          <Text style={{ fontSize: 6.5, color: TEXT_FAINT, marginTop: 6, lineHeight: 1.5 }}>
            {hasBud
              ? `Budget = ${period?.year} approved operating budget. Variance = actual - budget; favorable when revenue/NOI are above budget and expenses below.`
              : 'MTD / YTD / TTM derived from the GL category matview. Budget columns appear once an approved budget is loaded.'}
          </Text>
        </View>
      ) : (
        <Text style={{ fontSize: 8, color: TEXT_FAINT, marginBottom: 16 }}>No GL data loaded for this property.</Text>
      )}

      {/* ── Balance sheet ── */}
      <SectionLabel>Balance Sheet{period ? ` · per GL ${periodLabel(period)}` : ''}</SectionLabel>
      {bs ? (
        <View style={{ marginBottom: 16 }}>
          <BsSection label="Assets" lines={bs.assets} total={bs.totalAssets} />
          <BsSection label="Liabilities" lines={bs.liabilities} total={bs.totalLiabilities} />
          <BsSection label="Equity" lines={bs.equity} total={bs.totalEquity} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
            <Text style={{ fontSize: 7.5, color: TEXT_FAINT }}>Current earnings (unclosed P&L)</Text>
            <Text style={{ fontSize: 7.5, color: TEXT_FAINT }}>{fmt(bs.currentEarnings)}</Text>
          </View>
          <Text style={{ fontSize: 6.5, color: TEXT_FAINT, marginTop: 6, lineHeight: 1.5 }}>
            Cumulative GL balances (largest accounts shown per section). Assets = Liabilities + Equity + unclosed earnings.
          </Text>
        </View>
      ) : (
        <Text style={{ fontSize: 8, color: TEXT_FAINT, marginBottom: 16 }}>No GL data loaded for this property.</Text>
      )}

      {/* ── Top vendors (optional) ── */}
      {vendors && vendors.length > 0 ? (
        <View>
          <SectionLabel>{`Top Vendors by Spend · ${vendorWindowLabel}`}</SectionLabel>
          <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: WILKOW, paddingVertical: 3, paddingHorizontal: 4 }}>
            <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 0.8, color: TEXT_FAINT, flex: 1 }}>VENDOR</Text>
            <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 0.8, color: TEXT_FAINT, width: 60, textAlign: 'right' }}>INVOICES</Text>
            <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 0.8, color: TEXT_FAINT, width: 90, textAlign: 'right' }}>SPEND</Text>
          </View>
          {vendors.slice(0, 20).map((v, i) => (
            <View key={i} style={{ flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: RULE, paddingVertical: 3, paddingHorizontal: 4 }}>
              <Text style={{ fontSize: 8, color: TEXT, flex: 1 }}>{pdfSafe(cleanVendor(v.vendor))}</Text>
              <Text style={{ fontSize: 7.5, color: TEXT_MUTED, width: 60, textAlign: 'right' }}>{v.invoice_count}</Text>
              <Text style={{ fontSize: 7.5, color: TEXT, width: 90, textAlign: 'right' }}>{fmt(v.total_spend)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </ReportShell>
  )
}

function cleanVendor(v: string | null): string {
  if (!v) return '—'
  return v.replace(/\s*\(MRI-Property\)\s*$/i, '').trim()
}

function Kpi({ label, value, accent, last }: { label: string; value: string; accent: string; last?: boolean }) {
  return (
    <View style={{ flex: 1, marginRight: last ? 0 : 10, borderWidth: 0.75, borderColor: RULE, borderTopWidth: 2.5, borderTopColor: accent, borderRadius: 4, paddingVertical: 8, paddingHorizontal: 10 }}>
      <Text style={{ fontSize: 6, fontFamily: 'Helvetica-Bold', letterSpacing: 1, color: TEXT_FAINT, marginBottom: 5 }}>{label.toUpperCase()}</Text>
      <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 12.5, color: TEXT }}>{value}</Text>
    </View>
  )
}

// Column widths for the income statement (with / without budget columns).
const AMT_W = 66
const hcell = { fontSize: 6, fontFamily: 'Helvetica-Bold', letterSpacing: 0.6, color: TEXT_FAINT, textAlign: 'right' as const }

function StmtHeaderRow({ hasBud, period, year }: { hasBud: boolean; period: string; year: number | null }) {
  return (
    <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: WILKOW, paddingVertical: 3, paddingHorizontal: 4 }}>
      <Text style={{ ...hcell, flex: 1, textAlign: 'left' }}> </Text>
      <Text style={{ ...hcell, width: AMT_W }}>{`MTD ${period}`}</Text>
      <Text style={{ ...hcell, width: AMT_W }}>{`YTD ${year ?? ''}`}</Text>
      {hasBud ? <Text style={{ ...hcell, width: AMT_W }}>YTD BUD</Text> : null}
      {hasBud ? <Text style={{ ...hcell, width: AMT_W }}>YTD VAR</Text> : null}
      <Text style={{ ...hcell, width: AMT_W }}>TTM</Text>
    </View>
  )
}

function SubHead({ children }: { children: string }) {
  return (
    <Text style={{ fontSize: 7, fontFamily: 'Helvetica-Bold', letterSpacing: 0.6, color: TEXT_MUTED, textTransform: 'uppercase', marginTop: 8, marginBottom: 2, paddingHorizontal: 4 }}>
      {children}
    </Text>
  )
}

const amt = (n: number, negative?: boolean) => {
  const v = negative && n !== 0 ? -Math.abs(n) : n
  return fmt(v)
}

function StmtRow({ line, hasBud, indent, bold, accent, negative, muted, rule }: {
  line: StatementLine; hasBud: boolean; indent?: boolean; bold?: boolean
  accent?: boolean; negative?: boolean; muted?: boolean; rule?: boolean
}) {
  const color = accent ? WILKOW : muted ? TEXT_FAINT : bold ? TEXT : TEXT_MUTED
  const ff = bold ? 'Helvetica-Bold' : 'Helvetica'
  const budYtd = line.budYtd ?? 0
  const varYtd = line.ytd - budYtd
  const favorable = negative ? varYtd <= 0 : varYtd >= 0
  const varColor = Math.abs(varYtd) < 1 ? TEXT_FAINT : favorable ? GREEN : '#c25b52'
  const cell = (n: number, c: string = color, neg?: boolean) => (
    <Text style={{ width: AMT_W, textAlign: 'right', fontSize: 7.5, fontFamily: ff, color: c }}>{amt(n, neg)}</Text>
  )
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 2.5, paddingHorizontal: 4, borderTopWidth: rule ? 0.75 : 0, borderTopColor: rule ? WILKOW : undefined }}>
      <Text style={{ flex: 1, fontSize: 8, fontFamily: ff, color, paddingLeft: indent ? 10 : 0 }}>{pdfSafe(line.label)}</Text>
      {cell(line.mtd, color, negative)}
      {cell(line.ytd, color, negative)}
      {hasBud ? cell(line.budYtd ?? 0, TEXT_FAINT, negative) : null}
      {hasBud ? <Text style={{ width: AMT_W, textAlign: 'right', fontSize: 7.5, fontFamily: ff, color: varColor }}>{fmt(varYtd)}</Text> : null}
      {cell(line.ttm, color, negative)}
    </View>
  )
}

function BsSection({ label, lines, total }: { label: string; lines: BalanceSheetData['assets']; total: number }) {
  const sorted = [...lines].sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
  const shown = sorted.slice(0, 12)
  return (
    <View style={{ marginBottom: 6 }}>
      <SubHead>{label}</SubHead>
      {shown.map(l => (
        <View key={l.account_code} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 1.5, paddingHorizontal: 4 }}>
          <Text style={{ fontSize: 7.5, color: TEXT_MUTED, flex: 1, paddingRight: 8 }}>{pdfSafe(l.account_name ?? l.account_code)}</Text>
          <Text style={{ fontSize: 7.5, color: TEXT }}>{fmt(l.balance)}</Text>
        </View>
      ))}
      {sorted.length > 12 ? (
        <Text style={{ fontSize: 6.5, color: TEXT_FAINT, paddingHorizontal: 4 }}>{`+ ${sorted.length - 12} smaller accounts (in total below)`}</Text>
      ) : null}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.75, borderTopColor: WILKOW, marginTop: 2, paddingVertical: 2.5, paddingHorizontal: 4 }}>
        <Text style={{ fontSize: 8, fontFamily: 'Helvetica-Bold', color: TEXT }}>{`Total ${label}`}</Text>
        <Text style={{ fontSize: 8, fontFamily: 'Helvetica-Bold', color: TEXT }}>{fmt(total)}</Text>
      </View>
    </View>
  )
}
