import { useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { Link } from 'react-router-dom'
import { useProperties } from '../hooks/useProperties'
import { useFilteredPropertyIds, usePropertyNameMap } from '../hooks/useFilteredPropertyIds'
import { useArAging, useArDetail, useArNotes, useArContacts, useArFollowUps, normalizeTenantName, type ArAgingRow, type ArDetailLine, type ArFollowUpContact, type ArFollowUp } from '../hooks/useArAging'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { useReaAgreements } from '../hooks/useRea'
import { WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'
import { ArAgingPdfButton } from '../reports/ArAgingPdfButton'

// ── M&J Wilkow corporate palette (wilkow.com) ────────────────────────────────
// Slate #466371 is the site's primary accent; #8FA2AD is the wordmark grey-blue.
// Frank Ruhl Libre is the corporate serif (loaded in index.html).
const WILKOW       = '#466371'
const WILKOW_MIST  = '#8fa2ad'
const SERIF        = "'Frank Ruhl Libre', 'Cinzel', Georgia, serif"

const BUCKETS = [
  { key: 'current', label: 'Current',  color: WILKOW },
  { key: 'b30',     label: '30 Days',  color: '#c2a35a' },
  { key: 'b60',     label: '60 Days',  color: '#cf8544' },
  { key: 'b90',     label: '90 Days',  color: '#c25b52' },
  { key: 'b120',    label: '120+ Days', color: '#8e3d3d' },
] as const

type BucketKey = typeof BUCKETS[number]['key']

const fmt = (n: number) => {
  const s = Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  return n < 0 ? `(${s})` : s
}
const fmtCents = (n: number) => {
  const s = Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
  return n < 0 ? `(${s})` : s
}

type QuickFilter = 'all' | 'pastdue' | 'severe' | 'credits'
type SortKey = 'pastDue' | 'total' | 'current' | BucketKey | 'tenantName'

export function ReceivablesPage() {
  const { data: properties } = useProperties()
  const propertyIds = useFilteredPropertyIds(properties ?? null)
  const propertyNames = usePropertyNameMap(properties ?? null)
  const { data, loading, error } = useArAging(propertyIds, propertyNames)
  const rows = data ?? []
  const { data: notes } = useArNotes(propertyIds)
  const { data: arContacts } = useArContacts(propertyIds)
  const { data: followUps, refetch: refetchFollowUps } = useArFollowUps(propertyIds)
  const { data: reas } = useReaAgreements(propertyIds, propertyNames)
  // MRI lease ids that belong to REA parties (chip + cross-link to /rea)
  const reaMris = useMemo(() => {
    const s = new Set<string>()
    for (const a of reas ?? []) for (const m of a.members) if (m.mri) s.add(m.mri)
    return s
  }, [reas])

  const [quick, setQuick] = useState<QuickFilter>('all')
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('pastDue')
  const [sortDesc, setSortDesc] = useState(true)
  // open = expanded row; bucket preset filters the invoice-line drill
  const [open, setOpen] = useState<{ id: string; bucket: BucketKey | 'all' } | null>(null)

  const asOf = useMemo(() => rows.reduce<string | null>((m, r) => (!m || r.asOf > m ? r.asOf : m), null), [rows])

  // ── portfolio KPIs ──
  const kpi = useMemo(() => {
    const t = { total: 0, current: 0, pastDue: 0, severe: 0, credits: 0 }
    for (const r of rows) {
      t.total += r.total
      t.current += r.current
      t.pastDue += r.pastDue
      t.severe += r.b90 + r.b120
      if (r.total < 0) t.credits += r.total
    }
    return t
  }, [rows])

  // ── per-property rollup for the composition bars ──
  const byProperty = useMemo(() => {
    const m = new Map<string, { name: string; total: number; current: number; b30: number; b60: number; b90: number; b120: number }>()
    for (const r of rows) {
      const e = m.get(r.propertyId) ?? { name: r.propertyName, total: 0, current: 0, b30: 0, b60: 0, b90: 0, b120: 0 }
      e.total += r.total; e.current += r.current; e.b30 += r.b30; e.b60 += r.b60; e.b90 += r.b90; e.b120 += r.b120
      m.set(r.propertyId, e)
    }
    return Array.from(m.values()).sort((a, b) => b.total - a.total)
  }, [rows])

  // ── filtered + sorted table rows ──
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    let v = rows.filter(r => {
      if (quick === 'pastdue' && r.pastDue <= 0.005) return false
      if (quick === 'severe' && r.b90 + r.b120 <= 0.005) return false
      if (quick === 'credits' && r.total >= 0) return false
      if (q && !(`${r.tenantName} ${r.suite ?? ''} ${r.propertyName} ${r.mriLeaseId ?? ''}`.toLowerCase().includes(q))) return false
      return true
    })
    v = [...v].sort((a, b) => {
      if (sortKey === 'tenantName') {
        const c = a.tenantName.localeCompare(b.tenantName)
        return sortDesc ? -c : c
      }
      const c = (a[sortKey] as number) - (b[sortKey] as number)
      return sortDesc ? -c : c
    })
    return v
  }, [rows, quick, search, sortKey, sortDesc])

  function clickSort(k: SortKey) {
    if (sortKey === k) setSortDesc(d => !d)
    else { setSortKey(k); setSortDesc(true) }
  }

  return (
    <div style={{ padding: '26px 32px 48px', maxWidth: 1180 }}>
      {/* ── corporate header ── */}
      <div style={{ borderBottom: `2px solid ${WILKOW}`, paddingBottom: 16, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.28em', textTransform: 'uppercase', color: WILKOW_MIST, marginBottom: 6 }}>
            M&amp;J Wilkow · Portfolio Receivables
          </div>
          <div style={{ fontFamily: SERIF, fontSize: 27, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--text)', lineHeight: 1.15 }}>
            Accounts Receivable
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6 }}>
            Tenant aged delinquencies{asOf ? <> · as of <b style={{ color: 'var(--text)' }}>{asOf}</b></> : null} · source: MRI Aged Delinquencies
          </div>
        </div>
        <ArAgingPdfButton rows={rows} notes={notes ?? {}} reaMris={reaMris} asOf={asOf} />
      </div>

      {loading && <WidgetSkeleton rows={8} />}
      {error && <EmptyState title="Couldn't load receivables" subtitle={error} />}
      {!loading && !error && rows.length === 0 && (
        <EmptyState icon="📭" title="No A/R aging snapshots" subtitle="Load an MRI Aged Delinquencies export with scripts/load_ar_aging.ps1" />
      )}

      {!loading && !error && rows.length > 0 && (
        <>
          {/* ── KPI band (click to filter the tenant table) ── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 22 }}>
            <Kpi label="Total Outstanding" value={fmt(kpi.total)} accent={WILKOW} active={quick === 'all'} onClick={() => setQuick('all')} />
            <Kpi label="Current" value={fmt(kpi.current)} accent={WILKOW} sub={kpi.total > 0 ? `${Math.round(kpi.current / kpi.total * 100)}% of balance` : undefined} active={quick === 'all'} onClick={() => setQuick('all')} />
            <Kpi label="Past Due · 30d+" value={fmt(kpi.pastDue)} accent="#c2a35a" sub={kpi.total > 0 ? `${Math.round(kpi.pastDue / kpi.total * 100)}% of balance` : undefined} active={quick === 'pastdue'} onClick={() => setQuick('pastdue')} />
            <Kpi label="At Risk · 90d+" value={fmt(kpi.severe)} accent="#c25b52" active={quick === 'severe'} onClick={() => setQuick('severe')} />
            <Kpi label="Credits & Prepaids" value={fmt(kpi.credits)} accent="#65bc7b" active={quick === 'credits'} onClick={() => setQuick('credits')} />
          </div>

          {/* ── aging composition by property ── */}
          <SectionLabel>Aging Composition by Property</SectionLabel>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px', marginBottom: 22, boxShadow: 'var(--shadow, none)' }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
              {BUCKETS.map(b => (
                <span key={b.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--text-muted)' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: b.color, display: 'inline-block' }} />
                  {b.label}
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {byProperty.map(p => {
                const pos = Math.max(p.current, 0) + Math.max(p.b30, 0) + Math.max(p.b60, 0) + Math.max(p.b90, 0) + Math.max(p.b120, 0)
                return (
                  <div key={p.name}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{p.name}</span>
                      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{fmt(p.total)}</span>
                    </div>
                    <div style={{ display: 'flex', height: 14, borderRadius: 4, overflow: 'hidden', background: 'var(--surface-2)' }}>
                      {BUCKETS.map(b => {
                        const v = Math.max(p[b.key as BucketKey], 0)
                        if (pos <= 0 || v <= 0) return null
                        return (
                          <div
                            key={b.key}
                            title={`${b.label}: ${fmt(v)}`}
                            style={{ width: `${(v / pos) * 100}%`, background: b.color, minWidth: 2 }}
                          />
                        )
                      })}
                    </div>
                    <div style={{ display: 'flex', gap: 14, marginTop: 4, fontSize: 10, color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums', flexWrap: 'wrap' }}>
                      {BUCKETS.map(b => {
                        const v = p[b.key as BucketKey]
                        if (Math.abs(v) < 0.005) return null
                        return <span key={b.key}>{b.label}: <span style={{ color: 'var(--text-muted)' }}>{fmt(v)}</span></span>
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── controls ── */}
          <SectionLabel>Tenant Detail</SectionLabel>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search tenant, suite, property…"
              style={{
                flex: '0 1 280px', fontSize: 12.5, padding: '7px 12px', borderRadius: 8,
                border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text)', outline: 'none',
              }}
            />
            {([
              { k: 'all',     label: `All (${rows.length})` },
              { k: 'pastdue', label: `Past due (${rows.filter(r => r.pastDue > 0.005).length})` },
              { k: 'severe',  label: `90d+ (${rows.filter(r => r.b90 + r.b120 > 0.005).length})` },
              { k: 'credits', label: `Credits (${rows.filter(r => r.total < 0).length})` },
            ] as { k: QuickFilter; label: string }[]).map(f => (
              <button
                key={f.k}
                onClick={() => setQuick(f.k)}
                style={{
                  fontSize: 11, padding: '5px 12px', borderRadius: 99, cursor: 'pointer',
                  border: `1px solid ${quick === f.k ? WILKOW : 'var(--border-2)'}`,
                  background: quick === f.k ? WILKOW : 'transparent',
                  color: quick === f.k ? '#f2f3f5' : 'var(--text-muted)',
                  fontWeight: quick === f.k ? 600 : 400,
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* ── tenant table ── */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', boxShadow: 'var(--shadow, none)' }}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: `2px solid ${WILKOW}` }}>
                    <Th onClick={() => clickSort('tenantName')} active={sortKey === 'tenantName'} desc={sortDesc} align="left">Tenant</Th>
                    <Th align="left">Status</Th>
                    <Th align="left">Last Payment</Th>
                    <Th onClick={() => clickSort('current')} active={sortKey === 'current'} desc={sortDesc}>Current</Th>
                    <Th onClick={() => clickSort('b30')} active={sortKey === 'b30'} desc={sortDesc}>30d</Th>
                    <Th onClick={() => clickSort('b60')} active={sortKey === 'b60'} desc={sortDesc}>60d</Th>
                    <Th onClick={() => clickSort('b90')} active={sortKey === 'b90'} desc={sortDesc}>90d</Th>
                    <Th onClick={() => clickSort('b120')} active={sortKey === 'b120'} desc={sortDesc}>120d+</Th>
                    <Th onClick={() => clickSort('pastDue')} active={sortKey === 'pastDue'} desc={sortDesc}>Past Due</Th>
                    <Th onClick={() => clickSort('total')} active={sortKey === 'total'} desc={sortDesc}>Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map(r => (
                    <TenantRow
                      key={r.id}
                      row={r}
                      open={open?.id === r.id ? open.bucket : null}
                      note={(notes ?? {})[`${r.propertyId}|${r.mriLeaseId}`] ?? null}
                      isRea={r.mriLeaseId != null && reaMris.has(r.mriLeaseId)}
                      contacts={
                        (r.tenantId ? (arContacts ?? {})[`${r.propertyId}|id:${r.tenantId}`] : undefined)
                        ?? (arContacts ?? {})[`${r.propertyId}|nm:${normalizeTenantName(r.tenantName)}`]
                        ?? []
                      }
                      followUps={
                        (r.mriLeaseId ? (followUps ?? {})[`${r.propertyId}|mri:${r.mriLeaseId}`] : undefined)
                        ?? (followUps ?? {})[`${r.propertyId}|nm:${normalizeTenantName(r.tenantName)}`]
                        ?? []
                      }
                      onFollowUpLogged={refetchFollowUps}
                      onToggle={bucket => setOpen(open?.id === r.id && open.bucket === bucket ? null : { id: r.id, bucket })}
                    />
                  ))}
                  {visible.length === 0 && (
                    <tr><td colSpan={10} style={{ padding: 24, textAlign: 'center', color: 'var(--text-faint)', fontSize: 12 }}>No tenants match the current filter</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 12, lineHeight: 1.6 }}>
            Negative amounts (in parentheses) are credits / prepaid balances. Click a row — or any bucket amount — to drill into the underlying
            MRI invoice lines; KPI cards filter the table. Tenants marked <span style={{ color: WILKOW_MIST, fontWeight: 650 }}>REA</span> are
            easement-agreement parties, not leased tenants — see the REAs panel. A new export loaded via{' '}
            <code style={{ fontSize: 10 }}>scripts/load_ar_aging.ps1</code> replaces the snapshot.
          </div>
        </>
      )}
    </div>
  )
}

// ── pieces ───────────────────────────────────────────────────────────────────

function Kpi({ label, value, accent, sub, onClick, active }: {
  label: string; value: string; accent: string; sub?: string; onClick?: () => void; active?: boolean
}) {
  return (
    <div
      onClick={onClick}
      title={onClick ? 'Filter the tenant table' : undefined}
      style={{
        background: 'var(--surface)', borderRadius: 10, padding: '13px 15px', boxShadow: 'var(--shadow, none)',
        border: `1px solid ${active ? accent : 'var(--border)'}`, borderTop: `3px solid ${accent}`,
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div style={{ fontSize: 9.5, fontWeight: 650, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 7 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', fontFamily: SERIF, letterSpacing: '0.01em' }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div style={{ fontSize: 10.5, fontWeight: 650, letterSpacing: '0.18em', textTransform: 'uppercase', color: WILKOW_MIST, marginBottom: 8 }}>
      {children}
    </div>
  )
}

function Th({ children, onClick, active, desc, align = 'right' }: {
  children: string; onClick?: () => void; active?: boolean; desc?: boolean; align?: 'left' | 'right'
}) {
  return (
    <th
      onClick={onClick}
      style={{
        padding: '10px 12px', textAlign: align, whiteSpace: 'nowrap',
        fontSize: 10, fontWeight: 650, letterSpacing: '0.1em', textTransform: 'uppercase',
        color: active ? 'var(--text)' : 'var(--text-faint)',
        cursor: onClick ? 'pointer' : 'default', userSelect: 'none',
      }}
      title={onClick ? 'Sort' : undefined}
    >
      {children}{active ? (desc ? ' ↓' : ' ↑') : ''}
    </th>
  )
}

const td: CSSProperties = { padding: '9px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }

function Amt({ v, bold, color }: { v: number; bold?: boolean; color?: string }) {
  const zero = Math.abs(v) < 0.005
  return (
    <span style={{
      fontWeight: bold && !zero ? 650 : 400,
      color: zero ? 'var(--text-faint)' : v < 0 ? '#65bc7b' : (color ?? 'var(--text)'),
      opacity: zero ? 0.5 : 1,
    }}>
      {zero ? '—' : fmt(v)}
    </span>
  )
}

// One-click payment follow-up: a mailto draft that opens in the manager's own
// mail client (so the reply lands with them and nothing sends until they hit
// Send). Canned reminder + the aging snippet for this tenant, pre-addressed to
// the directory's billing contact when one exists.
const followUpTo = (contacts: ArFollowUpContact[]) => contacts.slice(0, 3).map(c => c.email).join(',')
const followUpSubject = (row: ArAgingRow) => `Past-Due Balance Reminder - ${row.tenantName} - ${row.propertyName}`

function buildFollowUpText(row: ArAgingRow, contacts: ArFollowUpContact[], detail: ArDetailLine[]) {
  const greetName = contacts[0]?.name
  const suite = row.suite ? `, Suite ${row.suite}` : ''
  const bucketLabel = (k: string) => BUCKETS.find(b => b.key === k)?.label ?? k

  // Charge-line detail, laid out like the MRI Aged Delinquencies report the
  // team is used to (date, code + description, amount, age), then category
  // subtotals and the total. Capped so the mailto URL stays within what mail
  // clients reliably accept (~2K chars); overflow is summarized, not dropped
  // silently. Falls back to the bucket summary when a row has no charge lines.
  const MAX_DETAIL = 14
  const shown = detail.slice(0, MAX_DETAIL)
  const body = shown.length > 0
    ? [
        `Detail of open charges:`,
        '',
        ...shown.map(l => {
          const cat = [l.category, l.categoryDesc].filter(Boolean).join(' - ') || 'Charge'
          return `  ${l.invoiceDate ? `${l.invoiceDate}  ` : ''}${cat}: ${fmtCents(l.amount)} (${bucketLabel(l.bucket)})`
        }),
        ...(detail.length > shown.length
          ? [`  ...plus ${detail.length - shown.length} additional charge lines - full statement available on request`]
          : []),
        '',
        ...(row.categories.length > 1
          ? [
              'Balance by category:',
              ...row.categories.slice(0, 8).map(c => `  ${c.code} ${c.desc}: ${fmtCents(c.total)}`),
              '',
            ]
          : []),
        `  Total balance: ${fmtCents(row.total)}  (past due 30d+: ${fmtCents(row.pastDue)})`,
      ]
    : [
        'Account summary:',
        '',
        ...([
          ['Current', row.current],
          ['30 days', row.b30],
          ['60 days', row.b60],
          ['90 days', row.b90],
          ['120+ days', row.b120],
        ] as Array<[string, number]>).filter(([, v]) => Math.abs(v) > 0.005).map(([label, v]) => `  ${label}: ${fmt(v)}`),
        `  Total balance: ${fmt(row.total)}`,
      ]

  const lines = [
    `Dear ${greetName ?? 'Accounts Payable Team'},`,
    '',
    `Our records show a past-due balance of ${fmt(row.pastDue)} for ${row.tenantName} at ${row.propertyName}${suite} as of ${row.asOf}.`,
    '',
    ...body,
    '',
    ...(row.lastPaymentDate
      ? [`Our last payment received was on ${row.lastPaymentDate}${row.lastPaymentAmount != null ? ` (${fmt(row.lastPaymentAmount)})` : ''}.`, '']
      : []),
    'Please arrange remittance of the past-due amount, or reply with a remittance update and your expected payment date. If you believe any of these charges are in error, let us know and we will research them promptly.',
    '',
    'Thank you,',
    '',
  ]
  return lines.join('\r\n')
}

function buildFollowUpMailto(row: ArAgingRow, contacts: ArFollowUpContact[], detail: ArDetailLine[]) {
  return `mailto:${encodeURIComponent(followUpTo(contacts))}?subject=${encodeURIComponent(followUpSubject(row))}&body=${encodeURIComponent(buildFollowUpText(row, contacts, detail))}`
}

// The rich version of the follow-up: a real HTML table shaped like the MRI
// Aged Delinquencies report — one row per open charge, aging buckets across
// the top, then a by-category recap and a bucket-totaled grand total row.
// mailto can't carry HTML, so this goes on the clipboard (see FollowUpBar) and
// the manager pastes it into the empty draft. All charge lines are included —
// the clipboard has no URL-length ceiling.
function buildFollowUpHtml(row: ArAgingRow, contacts: ArFollowUpContact[], detail: ArDetailLine[]) {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const money = (v: number) => (Math.abs(v) < 0.005 ? '' : esc(fmtCents(v)))
  const suite = row.suite ? `, Suite ${row.suite}` : ''
  const p = "font-family:Calibri,'Segoe UI',Arial,sans-serif;font-size:14px;color:#1a1a1a"
  const thL = 'border:1px solid #3a5260;padding:4px 10px;background:#466371;color:#ffffff;font-weight:600;text-align:left;white-space:nowrap'
  const thR = 'border:1px solid #3a5260;padding:4px 10px;background:#466371;color:#ffffff;font-weight:600;text-align:right;white-space:nowrap'
  const tdL = 'border:1px solid #c9ced3;padding:3px 10px;text-align:left'
  const tdR = 'border:1px solid #c9ced3;padding:3px 10px;text-align:right;white-space:nowrap'

  const lineRows = detail.map(l => `
    <tr>
      <td style="${tdL}">${esc(l.invoiceDate ?? '')}</td>
      <td style="${tdL}">${esc([l.category, l.categoryDesc].filter(Boolean).join(' - ') || 'Charge')}</td>
      ${BUCKETS.map(b => `<td style="${tdR}">${money(l.bucket === b.key ? l.amount : 0)}</td>`).join('')}
      <td style="${tdR}">${money(l.amount)}</td>
    </tr>`).join('')

  // Recap by category: bucket sums from the charge lines when we have them,
  // otherwise just the category totals the aging row carries.
  type CatSum = { desc: string; total: number; buckets: Record<BucketKey, number> }
  const cats = new Map<string, CatSum>()
  if (detail.length > 0) {
    for (const l of detail) {
      const code = l.category ?? '—'
      const e = cats.get(code) ?? { desc: l.categoryDesc ?? code, total: 0, buckets: { current: 0, b30: 0, b60: 0, b90: 0, b120: 0 } }
      e.total += l.amount
      e.buckets[l.bucket] += l.amount
      cats.set(code, e)
    }
  } else {
    for (const c of row.categories) cats.set(c.code, { desc: c.desc, total: c.total, buckets: { current: 0, b30: 0, b60: 0, b90: 0, b120: 0 } })
  }
  const recapRows = Array.from(cats.entries())
    .sort((a, b) => Math.abs(b[1].total) - Math.abs(a[1].total))
    .map(([code, c]) => `
    <tr>
      <td style="${tdL};background:#f4f6f7"></td>
      <td style="${tdL};background:#f4f6f7">${esc(`${code} ${c.desc}`)}</td>
      ${BUCKETS.map(b => `<td style="${tdR};background:#f4f6f7">${detail.length > 0 ? money(c.buckets[b.key]) : ''}</td>`).join('')}
      <td style="${tdR};background:#f4f6f7;font-weight:600">${money(c.total)}</td>
    </tr>`).join('')

  const totalRow = `
    <tr>
      <td style="${tdL};font-weight:700;background:#e8ecee">Total</td>
      <td style="${tdL};background:#e8ecee"></td>
      ${BUCKETS.map(b => `<td style="${tdR};font-weight:700;background:#e8ecee">${money(row[b.key])}</td>`).join('')}
      <td style="${tdR};font-weight:700;background:#e8ecee">${money(row.total)}</td>
    </tr>`

  return [
    `<p style="${p}">Dear ${esc(contacts[0]?.name ?? 'Accounts Payable Team')},</p>`,
    `<p style="${p}">Our records show a past-due balance of <b>${esc(fmt(row.pastDue))}</b> for ${esc(row.tenantName)} at ${esc(row.propertyName)}${esc(suite)} as of ${esc(row.asOf)}. Detail of open charges:</p>`,
    `<table style="border-collapse:collapse;font-family:Calibri,'Segoe UI',Arial,sans-serif;font-size:13px;color:#1a1a1a">`,
    `<tr><th style="${thL}">Invoice Date</th><th style="${thL}">Charge</th>${BUCKETS.map(b => `<th style="${thR}">${esc(b.label)}</th>`).join('')}<th style="${thR}">Total</th></tr>`,
    lineRows,
    recapRows,
    totalRow,
    `</table>`,
    ...(row.lastPaymentDate
      ? [`<p style="${p}">Our last payment received was on ${esc(row.lastPaymentDate)}${row.lastPaymentAmount != null ? ` (${esc(fmt(row.lastPaymentAmount))})` : ''}.</p>`]
      : []),
    `<p style="${p}">Please arrange remittance of the past-due amount, or reply with a remittance update and your expected payment date. If you believe any of these charges are in error, let us know and we will research them promptly.</p>`,
    `<p style="${p}">Thank you,</p>`,
  ].join('\n')
}

// A browser can't inject HTML into a desktop mail client (mailto is plain-text
// only), so the fully-formatted draft is delivered as an .eml file instead:
// X-Unsent: 1 makes Outlook open it as an EDITABLE, ready-to-send message with
// To/Subject/HTML table already in place — no pasting.
function downloadEmlDraft(row: ArAgingRow, contacts: ArFollowUpContact[], lines: ArDetailLine[]) {
  const html = `<html><body>${buildFollowUpHtml(row, contacts, lines)}</body></html>`
  // base64-encode UTF-8 safely (btoa alone chokes on non-latin1)
  const bytes = new TextEncoder().encode(html)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  const b64 = btoa(bin).replace(/(.{76})/g, '$1\r\n')
  const eml = [
    `To: ${followUpTo(contacts)}`,
    `Subject: ${followUpSubject(row)}`,
    'X-Unsent: 1',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    '',
  ].join('\r\n')
  const url = URL.createObjectURL(new Blob([eml], { type: 'message/rfc822' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `Follow-up - ${row.tenantName.replace(/[\\/:*?"<>|]/g, '')}.eml`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// One click: the formatted HTML table (charges × aging buckets + recap) goes
// on the clipboard AND an addressed, subject-lined draft opens in the manager's
// own mail client — they press Ctrl+V in the body and the whole formatted
// message drops in. If the clipboard is unavailable, the draft opens with the
// plain-text version in the body instead, so the flow never dead-ends.
// The "Outlook draft" variant skips the paste entirely via an .eml handoff.
function FollowUpBar({ row, contacts, lines, followUps, onLogged }: {
  row: ArAgingRow
  contacts: ArFollowUpContact[]
  lines: ArDetailLine[]
  followUps: ArFollowUp[]
  onLogged: () => void
}) {
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail' | 'eml'>('idle')
  const { appUser } = useAuth()

  // Best-effort log: record that a reminder draft was generated (NOT that it
  // was sent — the send happens in the manager's own mail client). A logging
  // failure must never block the draft itself, so errors are swallowed.
  const logFollowUp = async (method: 'eml' | 'mailto') => {
    try {
      await supabase.from('ar_followups').insert({
        property_id:   row.propertyId,
        tenant_id:     row.tenantId,
        mri_lease_id:  row.mriLeaseId,
        tenant_name:   row.tenantName,
        method,
        recipients:    contacts.slice(0, 3).map(c => c.email),
        past_due:      row.pastDue,
        total_balance: row.total,
        as_of:         row.asOf,
        sent_by_name:  appUser?.full_name ?? appUser?.email ?? null,
      })
    } catch { /* never block the draft on logging */ }
    onLogged()
  }

  const openDraft = async (e: ReactMouseEvent) => {
    e.preventDefault()
    let ok = false
    try {
      const CI: any = (window as any).ClipboardItem
      if (navigator.clipboard && 'write' in navigator.clipboard && CI) {
        await navigator.clipboard.write([new CI({
          'text/html':  new Blob([buildFollowUpHtml(row, contacts, lines)], { type: 'text/html' }),
          'text/plain': new Blob([buildFollowUpText(row, contacts, lines)], { type: 'text/plain' }),
        })])
        ok = true
      }
    } catch { /* clipboard blocked — fall through to the plain-text draft */ }
    setCopyState(ok ? 'ok' : 'fail')
    logFollowUp('mailto')
    window.location.href = ok
      ? `mailto:${encodeURIComponent(followUpTo(contacts))}?subject=${encodeURIComponent(followUpSubject(row))}`
      : buildFollowUpMailto(row, contacts, lines)
  }

  return (
    <div
      onClick={e => e.stopPropagation()}
      style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12, padding: '8px 12px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}
    >
      <button
        onClick={() => { downloadEmlDraft(row, contacts, lines); setCopyState('eml'); logFollowUp('eml') }}
        title="Generates the complete reminder email — open the downloaded draft and the formatted message is ready to edit and send from your own mailbox"
        style={{
          fontSize: 11.5, fontWeight: 600, padding: '5px 13px', borderRadius: 7, cursor: 'pointer',
          background: WILKOW, color: '#f2f3f5', border: 'none', whiteSpace: 'nowrap',
        }}
      >
        ✉ Email payment follow-up
      </button>
      <a
        href={buildFollowUpMailto(row, contacts, lines)}
        onClick={openDraft}
        title="Alternate: opens a draft in your mail client directly — the formatted table goes on the clipboard for you to paste into the body"
        style={{
          fontSize: 11.5, fontWeight: 600, padding: '4px 13px', borderRadius: 7,
          background: 'transparent', color: WILKOW, border: `1px solid ${WILKOW}`, textDecoration: 'none', whiteSpace: 'nowrap',
        }}
      >
        Compose via mail client
      </a>
      {copyState === 'eml' ? (
        <span style={{ fontSize: 10.5, color: 'var(--green)', fontWeight: 600 }}>
          Draft generated — open the downloaded file and the formatted email is ready to edit and send.
        </span>
      ) : copyState === 'ok' ? (
        <span style={{ fontSize: 10.5, color: 'var(--green)', fontWeight: 600 }}>
          Charge table copied — press Ctrl+V in the draft body to insert the formatted message.
        </span>
      ) : copyState === 'fail' ? (
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
          Clipboard unavailable — the draft opened with a plain-text summary instead.
        </span>
      ) : contacts.length > 0 ? (
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
          To: {contacts.slice(0, 3).map(c => c.name ? `${c.name} <${c.email}>` : c.email).join(' · ')}
          <span style={{ color: 'var(--text-faint)' }}> · {contacts[0].type === 'billing' ? 'billing contact' : `${contacts[0].type.replace('_', ' ')} contact`} on file</span>
        </span>
      ) : (
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>
          No email on file for this tenant — the draft opens unaddressed. <Link to="/contacts" style={{ color: 'var(--accent)' }}>Add one in Contacts →</Link>
        </span>
      )}
      {followUps.length > 0 && (
        <span
          title={followUps.slice(0, 8).map(f =>
            `${new Date(f.createdAt).toLocaleDateString()} — ${f.sentByName ?? 'unknown'}${f.pastDue != null ? ` · ${fmt(f.pastDue)} past due` : ''}${f.recipients.length ? ` · to ${f.recipients.join(', ')}` : ''}`
          ).join('\n')}
          style={{
            marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap',
            background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 99, padding: '2px 9px',
          }}
        >
          Last follow-up {new Date(followUps[0].createdAt).toLocaleDateString()}
          {followUps[0].sentByName ? ` by ${followUps[0].sentByName}` : ''}
          {followUps.length > 1 ? ` · ${followUps.length} total` : ''}
        </span>
      )}
    </div>
  )
}

function TenantRow({ row, open, note, isRea, contacts, followUps, onFollowUpLogged, onToggle }: {
  row: ArAgingRow
  open: BucketKey | 'all' | null   // which bucket the drill is filtered to (null = collapsed)
  note: string | null
  isRea: boolean
  contacts: ArFollowUpContact[]
  followUps: ArFollowUp[]
  onFollowUpLogged: () => void
  onToggle: (bucket: BucketKey | 'all') => void
}) {
  // Invoice lines feed both the composition graphic and the line table below
  // it — fetched once, lazily, only while the row is expanded.
  const { data: detailLines, loading: detailLoading, error: detailError } = useArDetail(open != null ? row.id : null)
  const worst = row.b120 > 0.005 ? BUCKETS[4] : row.b90 > 0.005 ? BUCKETS[3] : row.b60 > 0.005 ? BUCKETS[2] : row.b30 > 0.005 ? BUCKETS[1] : BUCKETS[0]
  const bucketCell = (key: BucketKey, v: number, color?: string) => (
    <td
      style={{ ...td, cursor: Math.abs(v) > 0.005 ? 'zoom-in' : 'pointer' }}
      onClick={e => { e.stopPropagation(); onToggle(Math.abs(v) > 0.005 ? key : 'all') }}
      title={Math.abs(v) > 0.005 ? 'Drill into these invoice lines' : undefined}
    >
      <Amt v={v} color={color} />
    </td>
  )
  return (
    <>
      <tr
        onClick={() => onToggle('all')}
        style={{
          borderBottom: '1px solid var(--border)',
          borderLeft: `3px solid ${row.pastDue > 0.005 ? worst.color : 'transparent'}`,
          cursor: 'pointer',
          background: open != null ? 'var(--surface-2)' : 'transparent',
        }}
      >
        <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal', minWidth: 200 }}>
          <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {row.tenantName}
            {isRea && (
              <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.1em', padding: '1px 7px', borderRadius: 99, background: WILKOW, color: '#f2f3f5' }} title="Party to a Reciprocal Easement Agreement — see the REAs panel">
                REA
              </span>
            )}
            {note && <span title={note} style={{ fontSize: 11 }}>📝</span>}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 1 }}>
            {row.propertyName}{row.suite ? ` · Suite ${row.suite}` : ''}
          </div>
        </td>
        <td style={{ ...td, textAlign: 'left' }}>
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 99,
            background: row.status === 'Current' ? 'var(--green-bg)' : 'var(--amber-bg)',
            border: `1px solid ${row.status === 'Current' ? 'var(--green-border)' : 'var(--amber-border)'}`,
            color: row.status === 'Current' ? 'var(--green)' : 'var(--amber)',
          }}>
            {row.status ?? '—'}
          </span>
        </td>
        <td style={{ ...td, textAlign: 'left', fontSize: 11, color: 'var(--text-muted)' }}>
          {row.lastPaymentDate ?? '—'}
          {row.lastPaymentAmount != null && <span style={{ color: 'var(--text-faint)' }}> · {fmt(row.lastPaymentAmount)}</span>}
        </td>
        {bucketCell('current', row.current)}
        {bucketCell('b30', row.b30, row.b30 > 0.005 ? BUCKETS[1].color : undefined)}
        {bucketCell('b60', row.b60, row.b60 > 0.005 ? BUCKETS[2].color : undefined)}
        {bucketCell('b90', row.b90, row.b90 > 0.005 ? BUCKETS[3].color : undefined)}
        {bucketCell('b120', row.b120, row.b120 > 0.005 ? BUCKETS[4].color : undefined)}
        <td style={td}><Amt v={row.pastDue} bold color={row.pastDue > 0.005 ? worst.color : undefined} /></td>
        <td style={td}><Amt v={row.total} bold /></td>
      </tr>
      {open != null && (
        <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-2)' }}>
          <td colSpan={10} style={{ padding: '12px 16px 14px 28px' }}>
            {note && (
              <div style={{ marginBottom: 10, padding: '8px 12px', background: 'var(--amber-bg)', border: '1px solid var(--amber-border)', borderRadius: 8, fontSize: 11.5, color: 'var(--text)', lineHeight: 1.55 }}>
                📝 {note}{isRea && <> · <Link to="/rea" style={{ color: 'var(--accent)' }}>open REAs panel →</Link></>}
              </div>
            )}
            {row.pastDue > 0.005 && (
              <FollowUpBar row={row} contacts={contacts} lines={detailLines ?? []} followUps={followUps} onLogged={onFollowUpLogged} />
            )}
            <CategoryAgedBars row={row} lines={detailLines ?? []} onBucket={b => onToggle(b)} />
            <div style={{ marginTop: 14 }}>
              <DetailLines lines={detailLines ?? []} loading={detailLoading} error={detailError} bucket={open} onBucket={b => onToggle(b)} />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// "Balance with detail": what the outstanding balance is made of (one bar per
// income category) and how old each piece is (segments = aging buckets, same
// palette as the property composition bars). Bar lengths are scaled to the
// largest category. Clicking a segment filters the invoice lines below to that
// bucket. While invoice lines are still loading (or absent for a row), falls
// back to solid single-color bars from the row's category totals.
function CategoryAgedBars({ row, lines, onBucket }: {
  row: ArAgingRow
  lines: ArDetailLine[]
  onBucket: (b: BucketKey | 'all') => void
}) {
  type CatBar = { code: string; desc: string; total: number; buckets: Record<BucketKey, number> }
  const emptyBuckets = (): Record<BucketKey, number> => ({ current: 0, b30: 0, b60: 0, b90: 0, b120: 0 })

  const aged = lines.length > 0
  let list: CatBar[]
  if (aged) {
    const m = new Map<string, CatBar>()
    for (const l of lines) {
      const code = l.category ?? '—'
      const e = m.get(code) ?? { code, desc: l.categoryDesc ?? code, total: 0, buckets: emptyBuckets() }
      e.total += l.amount
      e.buckets[l.bucket] += l.amount
      m.set(code, e)
    }
    list = Array.from(m.values())
  } else {
    list = row.categories.map(c => ({ code: c.code, desc: c.desc, total: c.total, buckets: emptyBuckets() }))
  }
  list.sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
  if (list.length === 0) return <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>No category detail on this row</span>

  // Bars are sized on positive (owed) amounts; credits show as green totals.
  const posOf = (c: CatBar) => aged
    ? BUCKETS.reduce((s, b) => s + Math.max(c.buckets[b.key], 0), 0)
    : Math.max(c.total, 0)
  const maxPos = Math.max(...list.map(posOf))

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 9.5, fontWeight: 650, letterSpacing: '0.14em', textTransform: 'uppercase', color: WILKOW_MIST }}>
          Balance Composition{row.mriLeaseId ? ` · MRI lease ${row.mriLeaseId}` : ''}
        </span>
        {aged && BUCKETS.map(b => (
          <span key={b.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9.5, color: 'var(--text-faint)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: b.color, display: 'inline-block' }} />
            {b.label}
          </span>
        ))}
        {aged && <span style={{ fontSize: 9.5, color: 'var(--text-faint)' }}>click a segment to filter the invoice lines</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {list.map(c => {
          const p = posOf(c)
          return (
            <div key={c.code} style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 210px) 1fr 96px', gap: 10, alignItems: 'center' }}>
              <span title={`${c.code} · ${c.desc}`} style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                <span style={{ fontWeight: 650, color: 'var(--text)', marginRight: 6 }}>{c.code}</span>{c.desc}
              </span>
              <div style={{ height: 13, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
                {p > 0.005 && maxPos > 0 && (
                  <div style={{ display: 'flex', height: '100%', width: `${(p / maxPos) * 100}%`, minWidth: 3 }}>
                    {aged
                      ? BUCKETS.map(b => {
                          const v = Math.max(c.buckets[b.key], 0)
                          if (v <= 0.005) return null
                          return (
                            <div
                              key={b.key}
                              onClick={e => { e.stopPropagation(); onBucket(b.key) }}
                              title={`${c.code} · ${b.label}: ${fmtCents(v)} — click to filter invoice lines`}
                              style={{ width: `${(v / p) * 100}%`, background: b.color, minWidth: 2, cursor: 'pointer' }}
                            />
                          )
                        })
                      : <div style={{ width: '100%', background: WILKOW, opacity: 0.55 }} />}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 11.5, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: c.total < 0 ? '#65bc7b' : 'var(--text)' }}>
                {fmtCents(c.total)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Invoice-level drill: the MRI report's underlying lines for one tenant,
// optionally filtered to the bucket cell that was clicked.
function DetailLines({ lines: allLines, loading, error, bucket, onBucket }: {
  lines: ArDetailLine[]
  loading: boolean
  error: string | null
  bucket: BucketKey | 'all'
  onBucket: (b: BucketKey | 'all') => void
}) {
  const lines = allLines.filter(l => bucket === 'all' || l.bucket === bucket)
  const bucketLabel = (k: string) => BUCKETS.find(b => b.key === k)?.label ?? k
  const bucketColor = (k: string) => BUCKETS.find(b => b.key === k)?.color ?? 'var(--text-muted)'
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 9.5, fontWeight: 650, letterSpacing: '0.14em', textTransform: 'uppercase', color: WILKOW_MIST }}>
          Invoice Lines
        </span>
        {(['all', ...BUCKETS.map(b => b.key)] as (BucketKey | 'all')[]).map(k => {
          const has = k === 'all' || allLines.some(l => l.bucket === k)
          if (!has) return null
          return (
            <button
              key={k}
              onClick={e => { e.stopPropagation(); if (k !== bucket) onBucket(k) }}
              style={{
                fontSize: 9.5, padding: '2px 9px', borderRadius: 99, cursor: 'pointer',
                border: `1px solid ${bucket === k ? WILKOW : 'var(--border-2)'}`,
                background: bucket === k ? WILKOW : 'transparent',
                color: bucket === k ? '#f2f3f5' : 'var(--text-muted)',
              }}
            >
              {k === 'all' ? 'All' : bucketLabel(k)}
            </button>
          )
        })}
      </div>
      {loading && <div style={{ fontSize: 11, color: 'var(--text-faint)', padding: '4px 0' }}>Loading invoice lines…</div>}
      {error && <div style={{ fontSize: 11, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && lines.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-faint)', padding: '4px 0' }}>No invoice lines in this bucket</div>
      )}
      {!loading && !error && lines.length > 0 && (
        <table style={{ borderCollapse: 'collapse', fontSize: 11, minWidth: 560 }}>
          <thead>
            <tr>
              {['Invoice Date', 'Category', 'Description', 'Src', 'Bucket', 'Amount'].map((h, i) => (
                <th key={h} style={{ padding: '4px 12px 4px 0', textAlign: i === 5 ? 'right' : 'left', fontSize: 9, fontWeight: 650, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '4px 12px 4px 0', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{l.invoiceDate ?? '—'}</td>
                <td style={{ padding: '4px 12px 4px 0', fontWeight: 650, color: 'var(--text)' }}>{l.category}</td>
                <td style={{ padding: '4px 12px 4px 0', color: 'var(--text-muted)' }}>{l.categoryDesc}</td>
                <td style={{ padding: '4px 12px 4px 0', color: 'var(--text-faint)' }} title={l.source === 'NC' ? 'Non-cash / credit memo' : l.source === 'CH' ? 'Charge' : l.source ?? ''}>{l.source ?? '—'}</td>
                <td style={{ padding: '4px 12px 4px 0', color: bucketColor(l.bucket), fontWeight: 600 }}>{bucketLabel(l.bucket)}</td>
                <td style={{ padding: '4px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: l.amount < 0 ? '#65bc7b' : 'var(--text)' }}>{fmtCents(l.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
