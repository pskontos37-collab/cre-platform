import { useMemo, useState, type CSSProperties } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useProperties } from '../hooks/useProperties'
import { useFilteredPropertyIds, usePropertyNameMap } from '../hooks/useFilteredPropertyIds'
import {
  useServiceAgreements, lifecycleOf, EXPIRING_WINDOW_DAYS, RESOLVED_LIFECYCLES,
  resolveServiceAgreement, restoreServiceAgreement,
  type ServiceAgreement, type Lifecycle, type Resolution,
} from '../hooks/useServiceAgreements'
import { WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'
import { PdfDownloadButton } from '../reports/PdfDownloadButton'
import type { SaReportGroup } from '../reports/ServiceAgreementsReport'

// ── M&J Wilkow corporate palette (wilkow.com) — see ReceivablesPage ─────────
const WILKOW      = '#466371'
const WILKOW_MIST = '#8fa2ad'
const SERIF       = "'Frank Ruhl Libre', 'Cinzel', Georgia, serif"

const fmt$ = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

const fmtDate = (iso: string | null) => {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const isoDaysFromNow = (days: number) => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

const daysUntil = (iso: string, todayIso: string) =>
  Math.round((Date.parse(iso) - Date.parse(todayIso)) / 86_400_000)

// Lifecycle presentation, in the order groups are listed (most urgent first).
const LIFECYCLE: Record<Lifecycle, { label: string; rank: number; color: string; bg: string; border: string }> = {
  expired:    { label: 'Expired',     rank: 0, color: 'var(--red)',        bg: 'var(--red-bg)',    border: 'var(--red-border)' },
  expiring:   { label: 'Expiring',    rank: 1, color: 'var(--amber)',      bg: 'var(--amber-bg)',  border: 'var(--amber-border)' },
  unknown:    { label: 'No term on file', rank: 2, color: 'var(--text-muted)', bg: 'var(--surface-2)', border: 'var(--border-2)' },
  active:     { label: 'Active',      rank: 3, color: 'var(--green)',      bg: 'var(--green-bg)',  border: 'var(--green-border)' },
  evergreen:  { label: 'Auto-renews', rank: 4, color: WILKOW_MIST,         bg: 'var(--surface-2)', border: 'var(--border-2)' },
  terminated: { label: 'Terminated',  rank: 5, color: 'var(--text-faint)', bg: 'var(--surface-2)', border: 'var(--border-2)' },
  superseded: { label: 'Superseded',  rank: 6, color: 'var(--text-faint)', bg: 'var(--surface-2)', border: 'var(--border-2)' },
  completed:  { label: 'Completed',   rank: 7, color: 'var(--green)',      bg: 'var(--surface-2)', border: 'var(--border-2)' },
  cancelled:  { label: 'Cancelled',   rank: 8, color: 'var(--text-faint)', bg: 'var(--surface-2)', border: 'var(--border-2)' },
  ignored:    { label: 'Ignored',     rank: 9, color: 'var(--text-faint)', bg: 'var(--surface-2)', border: 'var(--border-2)' },
}

// Manual dismissals (migration 20240078): all three leave the default list;
// cancelled + ignored require the audit note, completed doesn't need one.
const RESOLUTION_META: Record<Resolution, { icon: string; label: string; needsReason: boolean; title: string }> = {
  completed: { icon: '✓', label: 'Completed', needsReason: false, title: 'One-time job finished — nothing left to renew or track' },
  cancelled: { icon: '✕', label: 'Cancelled', needsReason: true,  title: 'Contract cancelled — a short note is required for the audit trail' },
  ignored:   { icon: '🚫', label: 'Ignored',   needsReason: true,  title: 'Not relevant to track — a short note is required for the audit trail' },
}

type SortMode = 'form-date' | 'date-desc' | 'date-asc' | 'vendor-asc' | 'vendor-desc' | 'expiry' | 'value-desc'

const SORT_LABELS: Record<SortMode, string> = {
  'form-date':  'Contract forms first, newest',
  'date-desc':  'Date — newest first',
  'date-asc':   'Date — oldest first',
  'vendor-asc': 'Vendor — A → Z',
  'vendor-desc':'Vendor — Z → A',
  'expiry':     'Expiration — soonest',
  'value-desc': 'Annual value — highest',
}

const baseName = (p: string | null) => (p ? p.split(/[\\/]/).pop() ?? '' : '')

/** True when the contract sits on M&J's standard Service Agreement form. The file
 *  room prefixes those files "AGR-"; AIA construction agreements, consulting
 *  letters (LTR/Consulting), change orders (CO-) and foreign vendor forms don't.
 *  Falls back to form language in the abstract when there's no filename. */
function isContractForm(a: ServiceAgreement): boolean {
  const fn = baseName(a.filePath)
  if (/^AGR[-\s]/i.test(fn)) return true
  if (/^(AIA|CO|LTR|CERT|AMD|PROP|CONSULTING)[-\s]/i.test(fn)) return false
  const blob = `${a.description ?? ''} ${a.termSummary ?? ''} ${a.notes ?? ''}`
  return /section 3\(|single-event service agreement|continuing services (agreement|term)|standard.{0,14}service agreement/i.test(blob)
}

/** The date a contract is ordered by: signing date, else start, else expiration. */
const sortDateOf = (a: ServiceAgreement) => a.agreementDate ?? a.startDate ?? a.endDate ?? ''

/** Vendor + category at one property = one relationship; latest contract governs. */
interface VendorGroup {
  key: string
  propertyName: string
  vendor: string
  category: string
  current: ServiceAgreement
  lifecycle: Lifecycle
  isForm: boolean
  prior: ServiceAgreement[]
}

function compareGroups(mode: SortMode): (a: VendorGroup, b: VendorGroup) => number {
  const d = (g: VendorGroup) => sortDateOf(g.current)
  switch (mode) {
    case 'date-desc':   return (a, b) => d(b).localeCompare(d(a)) || a.vendor.localeCompare(b.vendor)
    case 'date-asc':    return (a, b) => d(a).localeCompare(d(b)) || a.vendor.localeCompare(b.vendor)
    case 'vendor-asc':  return (a, b) => a.vendor.localeCompare(b.vendor)
    case 'vendor-desc': return (a, b) => b.vendor.localeCompare(a.vendor)
    case 'expiry':      return (a, b) => (a.current.endDate ?? '9999').localeCompare(b.current.endDate ?? '9999') || a.vendor.localeCompare(b.vendor)
    case 'value-desc':  return (a, b) => (b.current.annualValue ?? -1) - (a.current.annualValue ?? -1) || a.vendor.localeCompare(b.vendor)
    case 'form-date':
    default:            return (a, b) => (Number(b.isForm) - Number(a.isForm)) || d(b).localeCompare(d(a)) || a.vendor.localeCompare(b.vendor)
  }
}

export function ServiceAgreementsPage() {
  const { data: properties } = useProperties()
  const propertyIds = useFilteredPropertyIds(properties ?? null)
  const propertyNames = usePropertyNameMap(properties ?? null)
  const { data, loading, error, refetch } = useServiceAgreements(propertyIds, propertyNames)
  const agreements = data ?? []

  const [searchParams] = useSearchParams()
  const [lifecycleFilter, setLifecycleFilter] = useState<Lifecycle | null>(() => {
    const s = searchParams.get('status')
    const valid: string[] = ['expired', 'expiring', 'active', 'evergreen', 'terminated', 'superseded', 'completed', 'cancelled', 'ignored', 'unknown']
    return s && valid.includes(s) ? (s as Lifecycle) : null
  })
  const [categoryFilter, setCategoryFilter] = useState<string>('')
  const [search, setSearch] = useState('')
  const [sortMode, setSortMode] = useState<SortMode>('form-date')
  const [formOnly, setFormOnly] = useState(false)

  const todayIso = new Date().toISOString().slice(0, 10)
  const horizonIso = isoDaysFromNow(EXPIRING_WINDOW_DAYS)

  const groups = useMemo<VendorGroup[]>(() => {
    const m = new Map<string, ServiceAgreement[]>()
    for (const a of agreements) {
      const key = `${a.propertyId}|${a.vendor.toLowerCase().replace(/[^a-z0-9]/g, '')}|${a.category}`
      const list = m.get(key) ?? []
      list.push(a)
      m.set(key, list)
    }
    const out: VendorGroup[] = []
    for (const [key, list] of m) {
      // latest contract governs: prefer latest end date, then agreement/start date
      const sorted = [...list].sort((x, y) =>
        (y.endDate ?? y.agreementDate ?? y.startDate ?? '').localeCompare(x.endDate ?? x.agreementDate ?? x.startDate ?? ''))
      const current = sorted[0]
      out.push({
        key,
        propertyName: current.propertyName,
        vendor: current.vendor,
        category: current.category,
        current,
        lifecycle: lifecycleOf(current, todayIso, horizonIso),
        isForm: isContractForm(current),
        prior: sorted.slice(1),
      })
    }
    return out
  }, [agreements, todayIso, horizonIso])

  const counts = useMemo(() => {
    const c: Record<Lifecycle, number> = { expired: 0, expiring: 0, unknown: 0, active: 0, evergreen: 0, terminated: 0, superseded: 0, completed: 0, cancelled: 0, ignored: 0 }
    for (const g of groups) c[g.lifecycle]++
    return c
  }, [groups])

  const categories = useMemo(
    () => Array.from(new Set(groups.map(g => g.category))).sort(),
    [groups])

  const formCount = useMemo(() => groups.filter(g => g.isForm).length, [groups])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return groups
      // resolved relationships (completed/cancelled/ignored) only show under their explicit chip
      .filter(g => lifecycleFilter ? g.lifecycle === lifecycleFilter : !RESOLVED_LIFECYCLES.has(g.lifecycle))
      .filter(g => !categoryFilter || g.category === categoryFilter)
      .filter(g => !formOnly || g.isForm)
      .filter(g => !q || g.vendor.toLowerCase().includes(q) || g.category.toLowerCase().includes(q))
      .sort(compareGroups(sortMode))
  }, [groups, lifecycleFilter, categoryFilter, formOnly, search, sortMode])

  const byProperty = useMemo(() => {
    const m = new Map<string, VendorGroup[]>()
    for (const g of visible) {
      const list = m.get(g.propertyName) ?? []
      list.push(g)
      m.set(g.propertyName, list)
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [visible])

  // PDF export data: honours the category / contract-form / search filters, but
  // deliberately ignores the lifecycle chip so the report always shows BOTH
  // active and expired contracts. Resolved / superseded relationships are left out.
  const reportGroups = useMemo<SaReportGroup[]>(() => {
    const q = search.trim().toLowerCase()
    return groups
      .filter(g => !RESOLVED_LIFECYCLES.has(g.lifecycle) && g.lifecycle !== 'superseded')
      .filter(g => !categoryFilter || g.category === categoryFilter)
      .filter(g => !formOnly || g.isForm)
      .filter(g => !q || g.vendor.toLowerCase().includes(q) || g.category.toLowerCase().includes(q))
      .map(g => ({
        propertyName: g.propertyName,
        vendor: g.vendor,
        category: g.category,
        lifecycle: g.lifecycle,
        description: g.current.description,
        termSummary: g.current.termSummary,
        startDate: g.current.startDate,
        endDate: g.current.endDate,
        agreementDate: g.current.agreementDate,
        pricingSummary: g.current.pricingSummary,
        annualValue: g.current.annualValue,
        cancelNoticeDays: g.current.cancelNoticeDays,
        isForm: g.isForm,
      }))
  }, [groups, categoryFilter, formOnly, search])

  const scopeLabel = useMemo(() => {
    const names = new Set(reportGroups.map(g => g.propertyName))
    return names.size === 1 ? [...names][0] : `All properties (${names.size})`
  }, [reportGroups])

  return (
    <div style={{ padding: '26px 32px 48px', maxWidth: 1080 }}>
      {/* ── corporate header ── */}
      <div style={{ borderBottom: `2px solid ${WILKOW}`, paddingBottom: 16, marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.28em', textTransform: 'uppercase', color: WILKOW_MIST, marginBottom: 6 }}>
              M&amp;J Wilkow · Property Operations
            </div>
            <div style={{ fontFamily: SERIF, fontSize: 27, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--text)', lineHeight: 1.15 }}>
              Service Agreements
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
            <PdfDownloadButton
              label="⬇ PDF Report"
              filename={`Wilkow-Service-Agreements-${new Date().toISOString().slice(0, 10)}.pdf`}
              disabled={reportGroups.length === 0}
              title={reportGroups.length === 0 ? 'No service agreements in view' : 'Download a branded PDF of active & expired service contracts'}
              build={async () => {
                const { buildServiceAgreementsPdf } = await import('../reports/ServiceAgreementsReport')
                return buildServiceAgreementsPdf({
                  groups: reportGroups,
                  scopeLabel,
                  generatedAt: new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }),
                })
              }}
            />
            <Link to="/services/new" style={{
              textDecoration: 'none', fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
              padding: '8px 15px', borderRadius: 8, border: `1px solid ${WILKOW}`, background: WILKOW, color: '#f2f3f5',
            }}>
              + New Service Agreement
            </Link>
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6 }}>
          Vendor service contracts abstracted from the executed agreements in the corpus — one card per
          vendor relationship; the most recent contract governs, prior years fold underneath. Agreements on
          the standard contract form are listed first, newest by date — use <b>Sort</b> to reorder.
        </div>
      </div>

      {/* ── lifecycle chips (click to filter) ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {(Object.keys(LIFECYCLE) as Lifecycle[])
          .filter(k => counts[k] > 0)
          .map(k => {
            const on = lifecycleFilter === k
            const c = LIFECYCLE[k]
            return (
              <button
                key={k}
                onClick={() => setLifecycleFilter(on ? null : k)}
                style={{
                  fontSize: 11.5, fontWeight: 650, padding: '5px 12px', borderRadius: 99, cursor: 'pointer',
                  background: c.bg, color: c.color, border: `1px solid ${on ? c.color : c.border}`,
                  boxShadow: on ? `0 0 0 1px ${c.color}` : 'none',
                }}
                title={k === 'expiring' ? `End date within ${EXPIRING_WINDOW_DAYS} days` : undefined}
              >
                {c.label} · {counts[k]}
              </button>
            )
          })}
        {formCount > 0 && (
          <button
            onClick={() => setFormOnly(v => !v)}
            title="Show only agreements on the standard Service Agreement contract form"
            style={{
              fontSize: 11.5, fontWeight: 650, padding: '5px 12px', borderRadius: 99, cursor: 'pointer',
              background: 'var(--surface-2)', color: formOnly ? 'var(--accent)' : 'var(--text-muted)',
              border: `1px solid ${formOnly ? 'var(--accent)' : 'var(--border-2)'}`,
              boxShadow: formOnly ? '0 0 0 1px var(--accent)' : 'none',
            }}
          >
            📋 Contract form · {formCount}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <label style={{ fontSize: 10, fontWeight: 650, letterSpacing: '0.1em', textTransform: 'uppercase', color: WILKOW_MIST, alignSelf: 'center' }}>Sort</label>
        <select
          value={sortMode}
          onChange={e => setSortMode(e.target.value as SortMode)}
          style={{ fontSize: 12, padding: '5px 8px', borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)' }}
        >
          {(Object.keys(SORT_LABELS) as SortMode[]).map(m => <option key={m} value={m}>{SORT_LABELS[m]}</option>)}
        </select>
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          style={{ fontSize: 12, padding: '5px 8px', borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)' }}
        >
          <option value="">All categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search vendors…"
          style={{ fontSize: 12, padding: '5px 10px', borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)', width: 170 }}
        />
      </div>

      {loading && <WidgetSkeleton rows={8} />}
      {error && <EmptyState title="Couldn't load service agreements" subtitle={error} />}
      {!loading && !error && agreements.length === 0 && (
        <EmptyState icon="🔧" title="No service agreements" subtitle="Run scripts/extract_service_agreements.ps1 (then -Load), or adjust the property filter" />
      )}
      {!loading && !error && agreements.length > 0 && visible.length === 0 && (
        <EmptyState icon="🔍" title="Nothing matches the current filters" subtitle="Clear the lifecycle / contract-form / category / search filters above" />
      )}

      {byProperty.map(([propName, list]) => (
        <div key={propName} style={{ marginBottom: 26 }}>
          <div style={{ fontSize: 10.5, fontWeight: 650, letterSpacing: '0.18em', textTransform: 'uppercase', color: WILKOW_MIST, marginBottom: 10 }}>
            {propName} <span style={{ color: 'var(--text-faint)', letterSpacing: 0 }}>· {list.length} vendor{list.length === 1 ? '' : 's'}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {list.map(g => <VendorCard key={g.key} g={g} todayIso={todayIso} onChanged={refetch} />)}
          </div>
        </div>
      ))}
    </div>
  )
}

function VendorCard({ g, todayIso, onChanged }: { g: VendorGroup; todayIso: string; onChanged: () => void }) {
  const [showPrior, setShowPrior] = useState(false)
  const a = g.current
  const lc = LIFECYCLE[g.lifecycle]

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: `3px solid ${g.lifecycle === 'expired' ? 'var(--red)' : g.lifecycle === 'expiring' ? 'var(--amber)' : WILKOW}`, borderRadius: 12, padding: '14px 18px' }}>
      {/* title row */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: SERIF, fontSize: 15.5, fontWeight: 600, color: 'var(--text)' }}>{a.vendor}</span>
        <span style={{ fontSize: 10.5, fontWeight: 650, letterSpacing: '0.1em', textTransform: 'uppercase', color: WILKOW_MIST }}>{a.category}</span>
        {!g.isForm && (
          <span title="Not on the standard Service Agreement contract form (e.g. AIA, consulting letter, or vendor's own form)"
            style={{ fontSize: 9.5, fontWeight: 650, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-faint)', border: '1px solid var(--border-2)', borderRadius: 5, padding: '1px 6px' }}>
            off-form
          </span>
        )}
        <span style={{ flex: 1 }} />
        <ExpiryBlurb a={a} lifecycle={g.lifecycle} todayIso={todayIso} />
        <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 10px', borderRadius: 99, background: lc.bg, color: lc.color, border: `1px solid ${lc.border}`, whiteSpace: 'nowrap' }}>
          {lc.label}
        </span>
      </div>

      {a.description && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 7, lineHeight: 1.55 }}>{a.description}</div>
      )}

      {/* facts row */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 9 }}>
        {a.termSummary && <Fact label="Term">{a.termSummary}</Fact>}
        {!a.termSummary && (a.startDate || a.endDate) && (
          <Fact label="Term">{`${fmtDate(a.startDate) ?? '—'} → ${fmtDate(a.endDate) ?? 'open'}`}</Fact>
        )}
        {a.pricingSummary && <Fact label="Pricing">{a.pricingSummary}</Fact>}
        {a.annualValue != null && !a.pricingSummary && <Fact label="Annual value">{fmt$(a.annualValue)}</Fact>}
        {a.cancelNoticeDays != null && <Fact label="Cancel notice">{`${a.cancelNoticeDays} days`}</Fact>}
        {a.agreementDate && <Fact label="Dated">{fmtDate(a.agreementDate)!}</Fact>}
      </div>

      {a.notes && (
        <div style={{ marginTop: 9, padding: '7px 11px', background: 'var(--amber-bg)', border: '1px solid var(--amber-border)', borderRadius: 8, fontSize: 11.5, color: 'var(--text)', lineHeight: 1.5 }}>
          {a.notes}
        </div>
      )}

      {a.resolution && a.resolvedAt && (
        <div style={{ marginTop: 9, padding: '7px 11px', background: 'var(--surface-2)', border: '1px dashed var(--border-2)', borderRadius: 8, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          <span style={{ fontWeight: 650 }}>
            {RESOLUTION_META[a.resolution].icon} {RESOLUTION_META[a.resolution].label} {fmtDate(a.resolvedAt.slice(0, 10))}{a.resolvedByName ? ` by ${a.resolvedByName}` : ''}
          </span>
          {a.resolutionReason && <> — {a.resolutionReason}</>}
        </div>
      )}

      {/* document link + history + resolve/restore */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
        <DocChip a={a} label="View agreement" />
        {g.prior.length > 0 && (
          <button
            onClick={() => setShowPrior(s => !s)}
            style={{ fontSize: 10.5, padding: '3px 10px', borderRadius: 99, cursor: 'pointer', border: '1px solid var(--border-2)', color: 'var(--text-muted)', background: 'transparent' }}
          >
            {showPrior ? '▾' : '▸'} {g.prior.length} prior contract{g.prior.length === 1 ? '' : 's'}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <ResolveControl a={a} onChanged={onChanged} />
      </div>

      {showPrior && g.prior.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {g.prior.map(p => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 10px', background: 'var(--surface-2)', borderRadius: 7, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                {fmtDate(p.agreementDate ?? p.startDate) ?? 'undated'}
                {p.endDate ? ` → ${fmtDate(p.endDate)}` : ''}
              </span>
              {p.pricingSummary && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{p.pricingSummary}</span>}
              <span style={{ flex: 1 }} />
              <DocChip a={p} label="View" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** "expires in 42 d · Aug 16, 2026" next to the badge for anything with a horizon. */
function ExpiryBlurb({ a, lifecycle, todayIso }: { a: ServiceAgreement; lifecycle: Lifecycle; todayIso: string }) {
  if (!a.endDate || lifecycle === 'terminated' || lifecycle === 'superseded' || RESOLVED_LIFECYCLES.has(lifecycle)) return null
  const d = daysUntil(a.endDate, todayIso)
  const txt = d < 0 ? `ended ${fmtDate(a.endDate)}`
    : d === 0 ? `expires today`
    : `expires in ${d} d · ${fmtDate(a.endDate)}`
  return (
    <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', color: d < 0 ? 'var(--red)' : d <= EXPIRING_WINDOW_DAYS ? 'var(--amber)' : 'var(--text-faint)', whiteSpace: 'nowrap' }}>
      {txt}
    </span>
  )
}

/** Resolve (complete / cancel / ignore) or restore a vendor relationship.
 *  Cancelled and ignored REQUIRE a short note — it's stored on the row and
 *  every transition is written to audit_log (migration 20240078), so there's
 *  always a record of why something was dismissed and by whom. */
function ResolveControl({ a, onChanged }: { a: ServiceAgreement; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<Resolution | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const close = () => { setOpen(false); setChoice(null); setReason(''); setErr(null) }

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      close()
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(false)
    }
  }

  if (a.resolution) {
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {err && <span style={{ fontSize: 10.5, color: 'var(--red)' }}>{err}</span>}
        <button
          disabled={busy}
          onClick={() => run(() => restoreServiceAgreement(a.id))}
          title="Bring this agreement back into renewal tracking (the resolution note stays in the audit log)"
          style={{ fontSize: 10.5, padding: '3px 10px', borderRadius: 99, cursor: busy ? 'default' : 'pointer', border: '1px solid var(--border-2)', color: 'var(--text-muted)', background: 'var(--surface-2)', opacity: busy ? 0.6 : 1 }}
        >
          {busy ? 'Restoring…' : '↩ Restore'}
        </button>
      </span>
    )
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Mark this vendor relationship completed, cancelled or ignored — removes it from the default list, the renewals widget and the email digest"
        style={{ fontSize: 10.5, padding: '3px 10px', borderRadius: 99, cursor: 'pointer', border: '1px solid var(--border-2)', color: 'var(--text-faint)', background: 'transparent' }}
      >
        ✓ Mark…
      </button>
    )
  }

  const needsReason = choice != null && RESOLUTION_META[choice].needsReason
  const canConfirm = !busy && choice != null && (!needsReason || reason.trim().length > 0)

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {(Object.keys(RESOLUTION_META) as Resolution[]).map(r => {
        const meta = RESOLUTION_META[r]
        const on = choice === r
        return (
          <button
            key={r}
            disabled={busy}
            onClick={() => setChoice(on ? null : r)}
            title={meta.title}
            style={{
              fontSize: 10.5, fontWeight: 650, padding: '4px 10px', borderRadius: 99, cursor: 'pointer',
              border: `1px solid ${on ? 'var(--accent)' : 'var(--border-2)'}`,
              color: on ? 'var(--accent)' : 'var(--text-muted)', background: 'var(--surface-2)',
              boxShadow: on ? '0 0 0 1px var(--accent)' : 'none',
            }}
          >
            {meta.icon} {meta.label}
          </button>
        )
      })}
      {needsReason && (
        <input
          autoFocus
          value={reason}
          onChange={e => setReason(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') close() }}
          placeholder={`Why ${choice}? (required — kept for audit)`}
          style={{ fontSize: 11.5, padding: '4px 9px', borderRadius: 7, border: `1px solid ${err ? 'var(--red-border)' : 'var(--border-2)'}`, background: 'var(--surface-2)', color: 'var(--text)', width: 240 }}
        />
      )}
      {err && <span style={{ fontSize: 10.5, color: 'var(--red)' }}>{err}</span>}
      <button
        disabled={!canConfirm}
        onClick={() => { if (choice) run(() => resolveServiceAgreement(a.id, choice, reason)) }}
        style={{ fontSize: 10.5, fontWeight: 650, padding: '4px 11px', borderRadius: 99, cursor: canConfirm ? 'pointer' : 'default', border: '1px solid var(--border-2)', color: canConfirm ? 'var(--accent)' : 'var(--text-faint)', background: 'var(--surface-2)', opacity: busy ? 0.6 : 1 }}
      >
        {busy ? 'Saving…' : 'Confirm'}
      </button>
      <button
        disabled={busy}
        onClick={close}
        style={{ fontSize: 10.5, padding: '4px 9px', borderRadius: 99, cursor: 'pointer', border: 'none', color: 'var(--text-faint)', background: 'transparent' }}
      >
        Cancel
      </button>
    </span>
  )
}

/** Opens the source contract in document search (doc-search signs a storage view URL).
 *  Contracts not yet in the corpus (e.g. Gateway/Magnolia OPERATIONS folders) fall back
 *  to a copy-the-file-server-path chip. */
function DocChip({ a, label }: { a: ServiceAgreement; label: string }) {
  const [copied, setCopied] = useState(false)
  if (a.docTitle) {
    return (
      <Link
        to={`/documents?q=${encodeURIComponent(a.docTitle.slice(0, 140))}`}
        title={a.filePath ? `File server: ${a.filePath}` : 'Open in document search'}
        style={{ fontSize: 10.5, padding: '3px 10px', borderRadius: 99, textDecoration: 'none', border: '1px solid var(--border-2)', color: 'var(--accent)', background: 'var(--surface-2)' }}
      >
        📄 {label}
      </Link>
    )
  }
  if (!a.filePath) return null
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(a.filePath!).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        })
      }}
      title={`Copy file-server path:\n${a.filePath}`}
      style={{ fontSize: 10.5, padding: '3px 10px', borderRadius: 99, cursor: 'pointer', border: '1px solid var(--border-2)', color: 'var(--text-muted)', background: 'var(--surface-2)' }}
    >
      {copied ? '✓ path copied' : '📁 Copy file path'}
    </button>
  )
}

const factLbl: CSSProperties = {
  fontSize: 9.5, fontWeight: 650, letterSpacing: '0.14em', textTransform: 'uppercase',
  color: WILKOW_MIST, marginRight: 6,
}

function Fact({ label, children }: { label: string; children: string }) {
  return (
    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
      <span style={factLbl}>{label}</span>{children}
    </span>
  )
}
