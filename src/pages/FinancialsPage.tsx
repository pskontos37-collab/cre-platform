import { useState, useEffect, type ReactNode } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useProperties } from '../hooks/useProperties'
import { Widget, WidgetSkeleton, ChipSelect, ExpandToggle } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'
import { viewHref } from '../lib/viewer'
import { Badge } from '../components/ui/Badge'
import { CAMReconWidget } from '../components/dashboard/CAMReconWidget'
import { PdfDownloadButton, sanitizeFilename } from '../reports/PdfDownloadButton'
import {
  useVendorSpend, useGlAccounts, useDuplicateFlags,
  useDupDismissals, dismissDupFlag, restoreDupFlag, dupFlagKey,
  useIncomeStatement, useBalanceSheet, useRecentDocs,
  fetchAccountInvoices, fetchGlTransactions, fetchInvoicesByIds,
  SPEND_WINDOW_LABEL, SPEND_WINDOW_SHORT,
  type GlAccount, type AccountInvoice, type GlTxn, type SpendWindow,
  type DuplicateFlag, type FlagInvoice, type StatementLine, type RecentDoc,
} from '../hooks/useFinancials'

// Full drill-down sets are fetched (paged), but the table renders only the most
// recent slice — thousands of DOM rows would stall the page.
const MAX_DRILL_ROWS = 2000

// Preview counts for the side-by-side list widgets — collapse to a short
// preview with a "Show N more" toggle so a busy property doesn't render one
// long scroll (same pattern as Recent Documents).
const VENDOR_SPEND_PREVIEW = 8
const DUPLICATES_PREVIEW = 6

function TruncationNote({ shown, total, what }: { shown: number; total: number; what: string }) {
  return (
    <div style={{ padding: '6px 16px', fontSize: 11, color: 'var(--amber, #d97706)', borderBottom: '1px solid var(--border)' }}>
      Showing the {shown.toLocaleString()} most recent of {total.toLocaleString()} {what}.
    </div>
  )
}

const usd = (n: number, dp = 0) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: dp })
const shortDate = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-US', { year: '2-digit', month: 'short', day: 'numeric' }) : '—')

export function FinancialsPage() {
  const { appUser } = useAuth()
  const { data: properties } = useProperties()
  const propertyNames = Object.fromEntries((properties ?? []).map(p => [p.id, p.name]))
  const [propertyId, setPropertyId] = useState<string | null>(null)

  // Default to the first property once loaded.
  useEffect(() => {
    if (!propertyId && properties && properties.length > 0) setPropertyId(properties[0].id)
  }, [properties, propertyId])

  const [vendorWindow, setVendorWindow] = useState<SpendWindow>('90d')
  const [vendorsExpanded, setVendorsExpanded] = useState(false)
  const [docWindow, setDocWindow] = useState<SpendWindow>('30d')
  // Statement month (null = latest GL month); reset when switching property.
  const [stmtPeriod, setStmtPeriod] = useState<{ year: number; month: number } | null>(null)
  useEffect(() => { setStmtPeriod(null) }, [propertyId])
  const vendors    = useVendorSpend(propertyId, vendorWindow)
  const accounts   = useGlAccounts(propertyId)
  const duplicates = useDuplicateFlags(propertyId)
  const dismissals = useDupDismissals(propertyId)
  const stmt       = useIncomeStatement(propertyId, stmtPeriod)
  const bs         = useBalanceSheet(propertyId)
  const recentDocs = useRecentDocs(propertyId, docWindow)

  if (appUser?.role !== 'admin' && appUser?.role !== 'asset_manager') {
    return (
      <div style={{ padding: '40px 32px', color: 'var(--text-muted)', fontSize: 14 }}>
        You need admin or asset manager access to view financials.
      </div>
    )
  }

  const totalAp = (vendors.data ?? []).reduce((s, v) => s + v.total_spend, 0)

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1180 }}>
      {/* Header + property selector */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>Financials</h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Income statement (MTD / YTD / TTM), balance sheet, vendor spend, and AP drill-down —
            click any GL account for the invoices behind it, or any duplicate flag for the underlying invoices.
            Vendor spend and recent documents filter by date window (30 / 60 / 90 days, YTD, TTM, since acquisition).
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0 }}>
          <PdfDownloadButton
            label="⬇ PDF Report"
            filename={`Wilkow-Financials-${sanitizeFilename((propertyId && propertyNames[propertyId]) || 'property')}-${stmt.data?.latest ? `${stmt.data.latest.year}-${String(stmt.data.latest.month).padStart(2, '0')}` : new Date().toISOString().slice(0, 7)}.pdf`}
            disabled={!stmt.data && !bs.data}
            title={!stmt.data && !bs.data ? 'No GL data loaded for this property' : 'Download a branded PDF of the income statement, balance sheet, and top vendors'}
            build={async () => {
              const { buildFinancialsPdf } = await import('../reports/FinancialsReport')
              return buildFinancialsPdf({
                propertyName: (propertyId && propertyNames[propertyId]) || 'Property',
                stmt: stmt.data ?? null,
                bs: bs.data ?? null,
                vendors: vendors.data ?? null,
                vendorWindowLabel: SPEND_WINDOW_LABEL[vendorWindow],
                generatedAt: new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }),
              })
            }}
          />
          <select
            value={propertyId ?? ''}
            onChange={e => setPropertyId(e.target.value || null)}
            style={{
              background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6,
              color: 'var(--text)', fontSize: 13, padding: '7px 10px', cursor: 'pointer', outline: 'none',
            }}
          >
            {(properties ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
        <StatCard label="GL accounts" value={accounts.data ? String(accounts.data.length) : '—'} />
        <StatCard label={`AP — top 20 vendors (${SPEND_WINDOW_SHORT[vendorWindow]})`} value={vendors.data ? usd(totalAp) : '—'} />
        <StatCard label="Vendors" value={vendors.data ? String(vendors.data.length) : '—'} />
        <StatCard label="Duplicate flags" value={duplicates.data ? String(duplicates.data.length) : '—'}
          accent={duplicates.data && duplicates.data.length > 0 ? 'amber' : undefined} />
      </div>

      {/* Financial statements — MTD / YTD / TTM from the GL */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 16, marginBottom: 16 }}>
        <IncomeStatementPanel stmt={stmt.data ?? null} loading={stmt.loading} error={stmt.error} onPeriodChange={setStmtPeriod} />
        <BalanceSheetPanel bs={bs.data ?? null} loading={bs.loading} error={bs.error} asOf={stmt.data?.latest ?? null} />
      </div>

      {/* GL drill-down */}
      <div style={{ marginBottom: 16 }}>
        <GlDrilldown propertyId={propertyId} accounts={accounts.data} loading={accounts.loading} error={accounts.error} />
      </div>

      {/* Vendor spend + duplicates side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Widget
          title="Vendor Spend"
          chip={
            <ChipSelect
              value={vendorWindow}
              onChange={v => setVendorWindow(v as SpendWindow)}
              options={(Object.keys(SPEND_WINDOW_LABEL) as SpendWindow[]).map(w => ({ value: w, label: SPEND_WINDOW_LABEL[w] }))}
            />
          }
        >
          {vendors.loading && <WidgetSkeleton rows={8} />}
          {vendors.error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{vendors.error}</div>}
          {!vendors.loading && !vendors.error && (vendors.data ?? []).length === 0 && (
            <EmptyState title="No vendor data" subtitle={vendorWindow === 'all' ? 'Load invoices for this property' : `No AP activity in this window (${SPEND_WINDOW_LABEL[vendorWindow].toLowerCase()})`} />
          )}
          {!vendors.loading && (vendors.data ?? []).length > 0 && (() => {
            const allVendors = vendors.data!
            const shownVendors = vendorsExpanded ? allVendors : allVendors.slice(0, VENDOR_SPEND_PREVIEW)
            return (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {shownVendors.map((v, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0',
                    borderBottom: i < shownVendors.length - 1 ? '1px solid var(--border)' : 'none' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>
                      {cleanVendor(v.vendor)}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{v.invoice_count} inv</span>
                      <span style={{ fontSize: 12, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{usd(v.total_spend)}</span>
                    </div>
                  </div>
                ))}
                <ExpandToggle
                  expanded={vendorsExpanded}
                  onToggle={() => setVendorsExpanded(e => !e)}
                  collapsedCount={VENDOR_SPEND_PREVIEW}
                  totalCount={allVendors.length}
                />
              </div>
            )
          })()}
        </Widget>

        <DuplicatesWidget
          propertyId={propertyId}
          flags={duplicates.data}
          loading={duplicates.loading || dismissals.loading}
          error={duplicates.error ?? dismissals.error}
          dismissedKeys={dismissals.data ?? new Set()}
          onChanged={() => dismissals.refetch()}
          userEmail={appUser?.email ?? null}
        />
      </div>

      {/* Expense reconciliations — CAM / INS / RET true-ups. Shows only a short
          preview until expanded. */}
      <div style={{ marginTop: 16 }}>
        <CAMReconWidget
          propertyIds={propertyId ? [propertyId] : []}
          propertyNames={propertyNames}
          previewCount={5}
        />
      </div>

      {/* Recent documents — most recently modified corpus docs for this property,
          so you don't have to jump to the Documents panel. */}
      <div style={{ marginTop: 16 }}>
        <RecentDocsWidget
          docs={recentDocs.data}
          loading={recentDocs.loading}
          error={recentDocs.error}
          window={docWindow}
          onWindowChange={setDocWindow}
        />
      </div>
    </div>
  )
}

// Recent-documents panel: property docs ordered by file-server modified time,
// with a matching date-window filter (default: past 30 days). Collapsed to a
// short preview so the panel doesn't dominate the page on busy windows.
const RECENT_DOCS_PREVIEW = 5

function RecentDocsWidget({ docs, loading, error, window, onWindowChange }: {
  docs: RecentDoc[] | null
  loading: boolean
  error: string | null
  window: SpendWindow
  onWindowChange: (w: SpendWindow) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const all = docs ?? []
  const shown = expanded ? all : all.slice(0, RECENT_DOCS_PREVIEW)
  return (
    <Widget
      title="Recent Documents"
      chip={
        <ChipSelect
          value={window}
          onChange={v => onWindowChange(v as SpendWindow)}
          options={(Object.keys(SPEND_WINDOW_LABEL) as SpendWindow[]).map(w => ({ value: w, label: SPEND_WINDOW_LABEL[w] }))}
        />
      }
    >
      {loading && <WidgetSkeleton rows={6} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && (docs ?? []).length === 0 && (
        <EmptyState title="No recent documents" subtitle={`Nothing modified in this window (${SPEND_WINDOW_LABEL[window].toLowerCase()}) for this property`} />
      )}
      {!loading && all.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {shown.map((d, i) => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
              padding: '7px 0', borderBottom: i < shown.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <Badge variant={DOC_TYPE_VARIANT[d.doc_type] ?? 'gray'}>{d.doc_type.replace(/_/g, ' ')}</Badge>
                <span style={{ fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={d.title ?? d.file_path ?? ''}>
                  {d.title || docName(d.file_path) || '—'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap' }}>
                <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{shortDate(d.file_mtime)}</span>
                {d.view_url && (
                  <a href={viewHref(d.view_url)} target="_blank" rel="noreferrer"
                    style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none', fontWeight: 650 }}>
                    View ↗
                  </a>
                )}
              </div>
            </div>
          ))}
          <ExpandToggle
            expanded={expanded}
            onToggle={() => setExpanded(e => !e)}
            collapsedCount={RECENT_DOCS_PREVIEW}
            totalCount={all.length}
          />
        </div>
      )}
    </Widget>
  )
}

const DOC_TYPE_VARIANT: Record<string, 'blue' | 'green' | 'amber' | 'gray'> = {
  lease: 'blue', estoppel: 'green', loan_agreement: 'amber', operating_statement: 'gray',
}

// Filename from a "file:..."/"drive:..." path — display fallback when title is blank.
function docName(fp: string | null): string | null {
  if (!fp) return null
  const clean = fp.replace(/^file:/, '').replace(/^drive:/, '').replace(/#pages.*$/, '')
  return clean.split(/[\\/]/).pop() || null
}

// Duplicate-payments widget: active flags are dismissable (reviewed & cleared);
// dismissed ones collapse into a footer section with Restore. A dismissal is
// keyed to the exact invoice set — a new same-vendor/amount/date invoice later
// re-surfaces the flag.
function DuplicatesWidget({ propertyId, flags, loading, error, dismissedKeys, onChanged, userEmail }: {
  propertyId: string | null
  flags: DuplicateFlag[] | null
  loading: boolean
  error: string | null
  dismissedKeys: Set<string>
  onChanged: () => void
  userEmail: string | null
}) {
  const [showDismissed, setShowDismissed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const all = flags ?? []
  const active = all.filter(f => !dismissedKeys.has(dupFlagKey(f)))
  const dismissed = all.filter(f => dismissedKeys.has(dupFlagKey(f)))
  const shownActive = expanded ? active : active.slice(0, DUPLICATES_PREVIEW)

  async function act(flag: DuplicateFlag, kind: 'dismiss' | 'restore') {
    if (!propertyId) return
    setBusyKey(dupFlagKey(flag))
    try {
      if (kind === 'dismiss') await dismissDupFlag(propertyId, flag, userEmail)
      else await restoreDupFlag(propertyId, flag)
      onChanged()
    } finally {
      setBusyKey(null)
    }
  }

  return (
    <Widget title="Possible Duplicate Payments" chip={`Same vendor · amount · date${dismissed.length ? ` · ${dismissed.length} cleared` : ''}`}>
      {loading && <WidgetSkeleton rows={6} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && active.length === 0 && (
        <EmptyState icon="✓" title={dismissed.length ? 'All flags reviewed & cleared' : 'No duplicates flagged'} subtitle={dismissed.length ? `${dismissed.length} dismissed — show below` : 'No same-vendor, same-amount, same-date invoices'} />
      )}
      {!loading && active.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {shownActive.map((d, i) => (
            <DuplicateFlagRow
              key={dupFlagKey(d)}
              flag={d}
              last={i === shownActive.length - 1}
              busy={busyKey === dupFlagKey(d)}
              action={{ label: 'Dismiss', title: 'Mark reviewed — not a duplicate payment', run: () => act(d, 'dismiss') }}
            />
          ))}
          <ExpandToggle
            expanded={expanded}
            onToggle={() => setExpanded(e => !e)}
            collapsedCount={DUPLICATES_PREVIEW}
            totalCount={active.length}
          />
        </div>
      )}
      {!loading && dismissed.length > 0 && (
        <div style={{ marginTop: 8, borderTop: '1px dashed var(--border-2)', paddingTop: 6 }}>
          <button
            onClick={() => setShowDismissed(s => !s)}
            style={{ fontSize: 10.5, color: 'var(--text-faint)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            {showDismissed ? '▾' : '▸'} {dismissed.length} dismissed flag{dismissed.length === 1 ? '' : 's'}
          </button>
          {showDismissed && (
            <div style={{ display: 'flex', flexDirection: 'column', opacity: 0.65 }}>
              {dismissed.map((d, i) => (
                <DuplicateFlagRow
                  key={dupFlagKey(d)}
                  flag={d}
                  last={i === dismissed.length - 1}
                  busy={busyKey === dupFlagKey(d)}
                  action={{ label: 'Restore', title: 'Put this flag back on the active list', run: () => act(d, 'restore') }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </Widget>
  )
}

// A duplicate-payment flag: click to expand the underlying invoices with links.
function DuplicateFlagRow({ flag, last, action, busy }: {
  flag: DuplicateFlag
  last: boolean
  action?: { label: string; title: string; run: () => void }
  busy?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [invoices, setInvoices] = useState<FlagInvoice[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && !invoices && !loading) {
      setLoading(true)
      try {
        setInvoices(await fetchInvoicesByIds(flag.invoice_ids ?? []))
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load invoices')
      } finally {
        setLoading(false)
      }
    }
  }

  return (
    <div style={{ borderBottom: last ? 'none' : '1px solid var(--border)' }}>
      <div onClick={toggle} style={{ padding: '6px 0', cursor: 'pointer' }} title="Click to see the underlying invoices">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>
            <span style={{ color: 'var(--text-faint)', marginRight: 6 }}>{open ? '▾' : '▸'}</span>
            {cleanVendor(flag.vendor)}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--amber)', fontVariantNumeric: 'tabular-nums' }}>
              {usd(flag.invoice_total, 2)} × {flag.occurrences}
            </span>
            {action && (
              <button
                onClick={e => { e.stopPropagation(); if (!busy) action.run() }}
                title={action.title}
                disabled={busy}
                style={{
                  fontSize: 10, padding: '2px 9px', borderRadius: 99, cursor: busy ? 'wait' : 'pointer',
                  border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-muted)',
                }}
              >
                {busy ? '…' : action.label}
              </button>
            )}
          </span>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2, paddingLeft: 16 }}>
          {shortDate(flag.invoice_date)} · #{(flag.invoice_numbers ?? []).join(', #')}
        </div>
      </div>
      {open && (
        <div style={{ margin: '0 0 8px 16px', padding: 8, background: 'var(--surface-2)', borderRadius: 7 }}>
          {loading && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Loading invoices…</div>}
          {error && <div style={{ fontSize: 11, color: 'var(--red)' }}>{error}</div>}
          {invoices?.map(inv => (
            <div key={inv.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '4px 0' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11.5, color: 'var(--text)' }}>
                  #{inv.invoice_number ?? '—'} · {usd(inv.invoice_total, 2)}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                  inv {shortDate(inv.invoice_date)} · posted {shortDate(inv.posting_date)}{inv.memo ? ` · ${inv.memo}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, whiteSpace: 'nowrap' }}>
                {inv.image_url && (
                  <a href={inv.image_url} target="_blank" rel="noreferrer" style={{ fontSize: 10.5, color: 'var(--accent)' }}>Image ↗</a>
                )}
                {inv.invoice_url && (
                  <a href={inv.invoice_url} target="_blank" rel="noreferrer" style={{ fontSize: 10.5, color: 'var(--accent)' }}>Avid ↗</a>
                )}
              </div>
            </div>
          ))}
          <div style={{ fontSize: 9.5, color: 'var(--text-faint)', marginTop: 4 }}>
            Same vendor, amount, and invoice date with distinct Avid invoices — review for double payment.
          </div>
        </div>
      )}
    </div>
  )
}

// ── Financial statements ─────────────────────────────────────────────────────

const MON3 = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function IncomeStatementPanel({ stmt, loading, error, onPeriodChange }: {
  stmt: ReturnType<typeof useIncomeStatement>['data']
  loading: boolean
  error: string | null
  onPeriodChange: (p: { year: number; month: number } | null) => void
}) {
  const period = stmt?.latest ? `${MON3[stmt.latest.month]} ${stmt.latest.year}` : ''
  const hasBud = !!stmt?.hasBudget
  // Statement month picker — any GL month, newest first.
  const chip = stmt?.latest ? (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>GL{hasBud ? ' vs budget' : ''} ·</span>
      <select
        value={`${stmt.latest.year}-${stmt.latest.month}`}
        onChange={e => {
          const [y, m] = e.target.value.split('-').map(Number)
          onPeriodChange({ year: y, month: m })
        }}
        style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--surface-2)',
          border: '1px solid var(--border-2)', padding: '2px 6px', borderRadius: 99, cursor: 'pointer', outline: 'none' }}
      >
        {stmt.months.map(m => (
          <option key={`${m.year}-${m.month}`} value={`${m.year}-${m.month}`}>
            {MON3[m.month]} {m.year}
          </option>
        ))}
      </select>
    </span>
  ) : 'GL-derived'
  return (
    <Widget title="Income Statement" chip={chip} fullWidth={hasBud}>
      {loading && <WidgetSkeleton rows={10} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && !stmt && (
        <EmptyState title="No GL data" subtitle="Load this property's general ledger to build statements" />
      )}
      {!loading && !error && stmt && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ color: 'var(--text-faint)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              <th style={{ textAlign: 'left', padding: '4px 0' }}></th>
              <th style={{ textAlign: 'right', padding: '4px 0' }}>MTD ({period})</th>
              {hasBud && <th style={{ textAlign: 'right', padding: '4px 0' }}>MTD Bud</th>}
              <th style={{ textAlign: 'right', padding: '4px 0' }}>YTD {stmt.latest!.year}</th>
              {hasBud && <th style={{ textAlign: 'right', padding: '4px 0' }}>YTD Bud</th>}
              {hasBud && <th style={{ textAlign: 'right', padding: '4px 0' }}>YTD Var</th>}
              <th style={{ textAlign: 'right', padding: '4px 0' }}>TTM</th>
            </tr>
          </thead>
          <tbody>
            <SectionRow label="Income" />
            {stmt.income.map(l => <StmtRow key={l.category} line={l} indent showBud={hasBud} />)}
            <StmtRow line={stmt.revenue} bold topBorder showBud={hasBud} />
            <SectionRow label="Operating Expenses" />
            {stmt.expense.map(l => <StmtRow key={l.category} line={l} indent negative showBud={hasBud} />)}
            <StmtRow line={stmt.opex} bold topBorder negative showBud={hasBud} />
            <StmtRow line={stmt.noi} bold accent topBorder showBud={hasBud} />
            <StmtRow line={stmt.belowNoi} indent negative muted showBud={hasBud} />
            <StmtRow line={stmt.netIncome} bold topBorder showBud={hasBud} />
          </tbody>
        </table>
      )}
      <div style={{ marginTop: 10, fontSize: 10, color: 'var(--text-faint)' }}>
        {hasBud
          ? `Budget = ${stmt!.latest!.year} approved operating budget. Variance = actual − budget; green is favorable (revenue above / expenses below budget).`
          : 'Budget-vs-actual columns light up when this property’s approved budget is loaded (scripts/load_budget.ps1).'}
      </div>
    </Widget>
  )
}

function SectionRow({ label }: { label: string }) {
  return (
    <tr>
      <td colSpan={7} style={{ paddingTop: 8, paddingBottom: 2, fontSize: 10, fontWeight: 650, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </td>
    </tr>
  )
}

function StmtRow({ line, indent, bold, accent, negative, muted, topBorder, showBud }: {
  line: StatementLine; indent?: boolean; bold?: boolean; accent?: boolean
  negative?: boolean; muted?: boolean; topBorder?: boolean; showBud?: boolean
}) {
  const fmtAmt = (n: number) => {
    const v = negative && n !== 0 ? -Math.abs(n) : n
    const s = Math.abs(v).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    return v < 0 ? `(${s})` : s
  }
  const color = accent ? 'var(--accent)' : muted ? 'var(--text-faint)' : bold ? 'var(--text)' : 'var(--text-muted)'
  const border = topBorder ? '1px solid var(--border)' : undefined
  const cell = (n: number, c: string = color, pad = 0) => (
    <td style={{ textAlign: 'right', padding: '3px 0', paddingLeft: pad, color: c, fontWeight: bold ? 700 : 400, fontVariantNumeric: 'tabular-nums', borderTop: border }}>
      {fmtAmt(n)}
    </td>
  )
  // Variance = actual − budget. Favorable (green): revenue/NOI above budget,
  // expense-type rows below budget.
  const budYtd = line.budYtd ?? 0
  const varYtd = line.ytd - budYtd
  const favorable = negative ? varYtd <= 0 : varYtd >= 0
  const varColor = Math.abs(varYtd) < 1 ? 'var(--text-faint)' : favorable ? 'var(--green, #22c55e)' : 'var(--red)'
  return (
    <tr>
      <td style={{ padding: '3px 0', paddingLeft: indent ? 12 : 0, color, fontWeight: bold ? 650 : 400, borderTop: border }}>
        {line.label}
      </td>
      {cell(line.mtd)}
      {showBud && cell(line.budMtd ?? 0, 'var(--text-faint)', 10)}
      {cell(line.ytd, color, 10)}
      {showBud && cell(line.budYtd ?? 0, 'var(--text-faint)', 10)}
      {showBud && (
        <td style={{ textAlign: 'right', padding: '3px 0', paddingLeft: 10, color: varColor, fontWeight: bold ? 700 : 400, fontVariantNumeric: 'tabular-nums', borderTop: border }}>
          {varYtd < 0 ? `(${Math.abs(varYtd).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })})` : varYtd.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
        </td>
      )}
      {cell(line.ttm, color, 10)}
    </tr>
  )
}

function BalanceSheetPanel({ bs, loading, error, asOf }: {
  bs: ReturnType<typeof useBalanceSheet>['data']
  loading: boolean
  error: string | null
  asOf: { year: number; month: number } | null
}) {
  const usd0 = (n: number) => {
    const s = Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    return n < 0 ? `(${s})` : s
  }
  const section = (label: string, unsorted: BsLineList, total: number) => {
    const lines = [...unsorted].sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
    return (
    <>
      <div style={{ fontSize: 10, fontWeight: 650, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '8px 0 2px' }}>{label}</div>
      {lines.slice(0, 14).map(l => (
        <div key={l.account_code} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 0' }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {l.account_name ?? l.account_code}
          </span>
          <span style={{ fontSize: 11.5, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{usd0(l.balance)}</span>
        </div>
      ))}
      {lines.length > 14 && (
        <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>+ {lines.length - 14} smaller accounts (in total below)</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', marginTop: 3, padding: '3px 0', fontWeight: 700 }}>
        <span style={{ fontSize: 11.5, color: 'var(--text)' }}>Total {label}</span>
        <span style={{ fontSize: 11.5, color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{usd0(total)}</span>
      </div>
    </>
    )
  }
  return (
    <Widget title="Balance Sheet" chip={asOf ? `per GL · ${MON3[asOf.month]} ${asOf.year}` : 'per GL'}>
      {loading && <WidgetSkeleton rows={10} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && !bs && (
        <EmptyState title="No GL data" subtitle="Load this property's general ledger to build a balance sheet" />
      )}
      {!loading && !error && bs && (
        <div>
          {section('Assets', bs.assets, bs.totalAssets)}
          {section('Liabilities', bs.liabilities, bs.totalLiabilities)}
          {section('Equity', bs.equity, bs.totalEquity)}
          <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', marginTop: 4 }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Current earnings (unclosed P&L)</span>
            <span style={{ fontSize: 11.5, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>
              {usd0(bs.currentEarnings)}
            </span>
          </div>
          <div style={{ marginTop: 8, fontSize: 9.5, color: 'var(--text-faint)' }}>
            Cumulative GL balances (sorted by account, largest sections shown). Ties to Assets = Liabilities + Equity + unclosed earnings.
          </div>
        </div>
      )}
    </Widget>
  )
}

type BsLineList = Array<{ account_code: string; account_name: string | null; balance: number }>

function GlDrilldown({ propertyId, accounts, loading, error }: {
  propertyId: string | null
  accounts: GlAccount[] | null
  loading: boolean
  error: string | null
}) {
  const [selected, setSelected] = useState<GlAccount | null>(null)
  const [filter, setFilter]     = useState('')
  const [tab, setTab]           = useState<'invoices' | 'gl'>('invoices')
  const [invoices, setInvoices] = useState<AccountInvoice[] | null>(null)
  const [txns, setTxns]         = useState<GlTxn[] | null>(null)
  const [drillLoading, setDrillLoading] = useState(false)
  const [drillError, setDrillError]     = useState<string | null>(null)
  // Period scope for the drill-down ('' = all). Month applies within a year.
  const [year, setYear]   = useState<number | ''>('')
  const [month, setMonth] = useState<number | ''>('')

  // Reset selection when property changes.
  useEffect(() => { setSelected(null); setInvoices(null); setTxns(null) }, [propertyId])

  async function load(acct: GlAccount, y: number | '', m: number | '') {
    if (!propertyId) return
    setDrillLoading(true); setDrillError(null)
    setInvoices(null); setTxns(null)
    try {
      const py = y === '' ? undefined : y
      const pm = y === '' || m === '' ? undefined : m
      const [inv, tx] = await Promise.all([
        fetchAccountInvoices(propertyId, acct.account_code, py, pm),
        fetchGlTransactions(propertyId, acct.account_code, py, pm),
      ])
      setInvoices(inv); setTxns(tx)
    } catch (e) {
      setDrillError(e instanceof Error ? e.message : 'Failed to load account detail')
    } finally {
      setDrillLoading(false)
    }
  }

  function selectAccount(acct: GlAccount) {
    setSelected(acct); setTab('invoices')
    void load(acct, year, month)
  }

  function changePeriod(y: number | '', m: number | '') {
    setYear(y); setMonth(y === '' ? '' : m)
    if (selected) void load(selected, y, y === '' ? '' : m)
  }

  // Year choices spanning the selected account's activity. The source GL has a
  // few typo entry_dates (1919/2525/8024) — clamp to a sane window so they
  // can't inflate the list.
  const yearChoices = (() => {
    const now = new Date().getFullYear()
    let a = 2019, b = now
    if (selected?.first_date && selected?.last_date) {
      const fa = new Date(selected.first_date).getFullYear()
      const fb = new Date(selected.last_date).getFullYear()
      a = Math.min(Math.max(fa, 2005), now)
      b = Math.max(Math.min(fb, now), a)
    }
    const ys: number[] = []
    for (let y = b; y >= a; y--) ys.push(y)
    return ys
  })()

  const shown = (accounts ?? []).filter(a => {
    if (!filter) return true
    const q = filter.toLowerCase()
    return a.account_code.toLowerCase().includes(q) || (a.account_name ?? '').toLowerCase().includes(q)
  })

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
          General Ledger — Account Drill-Down
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', minHeight: 420 }}>
        {/* Account list */}
        <div style={{ borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 10, borderBottom: '1px solid var(--border)' }}>
            <input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter accounts…"
              style={{ width: '100%', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6,
                color: 'var(--text)', fontSize: 12, padding: '6px 10px', outline: 'none' }}
            />
          </div>
          <div style={{ overflowY: 'auto', maxHeight: 520 }}>
            {loading && <div style={{ padding: 14 }}><WidgetSkeleton rows={8} /></div>}
            {error && <div style={{ padding: 14, fontSize: 12, color: 'var(--red)' }}>{error}</div>}
            {!loading && shown.map(a => (
              <button
                key={a.account_code}
                onClick={() => selectAccount(a)}
                style={{
                  width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                  background: selected?.account_code === a.account_code ? 'var(--accent-dim)' : 'transparent',
                  borderBottom: '1px solid var(--border)', padding: '8px 12px',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: selected?.account_code === a.account_code ? 'var(--accent)' : 'var(--text)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {a.account_name ?? a.account_code}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{a.account_code} · {a.txn_count} txns</div>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                  {usd(a.net)}
                </span>
              </button>
            ))}
            {!loading && shown.length === 0 && (
              <div style={{ padding: 14 }}><EmptyState title="No accounts" subtitle="No GL data for this property" /></div>
            )}
          </div>
        </div>

        {/* Detail panel */}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {!selected ? (
            <div style={{ margin: 'auto', padding: 40 }}>
              <EmptyState icon="👈" title="Select a GL account" subtitle="See the invoices and transactions behind it" />
            </div>
          ) : (
            <>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{selected.account_name ?? selected.account_code}</div>
                <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
                  {selected.account_code} · {usd(selected.total_debit)} dr / {usd(selected.total_credit)} cr · net {usd(selected.net)}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                  {(['invoices', 'gl'] as const).map(t => (
                    <button key={t} onClick={() => setTab(t)}
                      style={{ padding: '4px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer',
                        fontWeight: tab === t ? 600 : 400,
                        border: `1px solid ${tab === t ? 'var(--accent)' : 'var(--border)'}`,
                        background: tab === t ? 'var(--accent-dim)' : 'transparent',
                        color: tab === t ? 'var(--accent)' : 'var(--text-muted)' }}>
                      {t === 'invoices' ? `Invoices${invoices ? ` (${invoices.length})` : ''}` : `GL Transactions${txns ? ` (${txns.length})` : ''}`}
                    </button>
                  ))}
                  {/* Period scope — the RPCs filter server-side on year/month */}
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>Period:</span>
                    <select value={year === '' ? '' : String(year)}
                      onChange={e => changePeriod(e.target.value === '' ? '' : Number(e.target.value), month)}
                      style={{ fontSize: 11, background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6, color: 'var(--text)', padding: '3px 6px', cursor: 'pointer' }}>
                      <option value="">All years</option>
                      {yearChoices.map(y => <option key={y} value={y}>{y}</option>)}
                    </select>
                    <select value={month === '' ? '' : String(month)} disabled={year === ''}
                      onChange={e => changePeriod(year, e.target.value === '' ? '' : Number(e.target.value))}
                      style={{ fontSize: 11, background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6, color: year === '' ? 'var(--text-faint)' : 'var(--text)', padding: '3px 6px', cursor: year === '' ? 'not-allowed' : 'pointer' }}>
                      <option value="">All months</option>
                      {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
                        <option key={m} value={m}>{['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m]}</option>
                      ))}
                    </select>
                  </span>
                </div>
              </div>

              <div style={{ flex: 1, overflowY: 'auto', maxHeight: 460 }}>
                {drillLoading && <div style={{ padding: 16 }}><WidgetSkeleton rows={8} /></div>}
                {drillError && <div style={{ padding: 16, fontSize: 12, color: 'var(--red)' }}>{drillError}</div>}

                {!drillLoading && tab === 'invoices' && (
                  (invoices ?? []).length === 0
                    ? <div style={{ padding: 20 }}><EmptyState title="No invoices" subtitle="No AP invoices coded to this account" /></div>
                    : <>
                        {invoices!.length > MAX_DRILL_ROWS && (
                          <TruncationNote shown={MAX_DRILL_ROWS} total={invoices!.length} what="invoices" />
                        )}
                        {/* account_invoices orders posting_date desc — slice(0) keeps the most recent */}
                        <InvoiceTable rows={invoices!.slice(0, MAX_DRILL_ROWS)} />
                      </>
                )}
                {!drillLoading && tab === 'gl' && (
                  (txns ?? []).length === 0
                    ? <div style={{ padding: 20 }}><EmptyState title="No transactions" /></div>
                    : <>
                        {txns!.length > MAX_DRILL_ROWS && (
                          <TruncationNote shown={MAX_DRILL_ROWS} total={txns!.length} what="transactions" />
                        )}
                        {/* gl_transactions orders entry_date asc — slice(-N) keeps the most recent */}
                        <GlTable rows={txns!.slice(-MAX_DRILL_ROWS)} />
                      </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function InvoiceTable({ rows }: { rows: AccountInvoice[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          {['Vendor', 'Invoice #', 'Posted', 'Amount', 'Source'].map(h => <Th key={h} right={h === 'Amount'}>{h}</Th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.invoice_id + i} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={{ padding: '7px 12px', color: 'var(--text-muted)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {cleanVendor(r.vendor)}
            </td>
            <td style={{ padding: '7px 12px', color: 'var(--text-faint)' }}>{r.invoice_number ?? '—'}</td>
            <td style={{ padding: '7px 12px', color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{shortDate(r.posting_date)}</td>
            <td style={{ padding: '7px 12px', color: 'var(--text)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{usd(r.amount, 2)}</td>
            <td style={{ padding: '7px 12px', whiteSpace: 'nowrap' }}>
              {r.image_url && <a href={r.image_url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none', marginRight: 8 }}>Image ↗</a>}
              {r.invoice_url && <a href={r.invoice_url} target="_blank" rel="noreferrer" style={{ color: 'var(--text-faint)', textDecoration: 'none' }}>Portal ↗</a>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function GlTable({ rows }: { rows: GlTxn[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          {['Date', 'Ref', 'Description', 'Debit', 'Credit'].map(h => <Th key={h} right={h === 'Debit' || h === 'Credit'}>{h}</Th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
            <td style={{ padding: '7px 12px', color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{shortDate(r.entry_date)}</td>
            <td style={{ padding: '7px 12px', color: 'var(--text-faint)' }}>{r.reference ?? '—'}</td>
            <td style={{ padding: '7px 12px', color: 'var(--text-muted)', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.description ?? '—'}</td>
            <td style={{ padding: '7px 12px', color: r.debit ? 'var(--text)' : 'var(--text-faint)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.debit ? usd(r.debit, 2) : '—'}</td>
            <td style={{ padding: '7px 12px', color: r.credit ? 'var(--text)' : 'var(--text-faint)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.credit ? usd(r.credit, 2) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return (
    <th style={{ padding: '8px 12px', textAlign: right ? 'right' : 'left', fontWeight: 500, fontSize: 10,
      color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.04em' }}>
      {children}
    </th>
  )
}

function StatCard({ label, value, accent }: { label: string; value: string; accent?: 'amber' }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: accent === 'amber' ? 'var(--amber)' : 'var(--text)' }}>{value}</div>
    </div>
  )
}

// MRI vendor names carry a "(MRI-Property)" suffix — trim it for display.
function cleanVendor(v: string | null): string {
  if (!v) return '—'
  return v.replace(/\s*\(MRI-Property\)\s*$/i, '').trim()
}
