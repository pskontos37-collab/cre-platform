import { useMemo, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { useProperties } from '../hooks/useProperties'
import { useFilteredPropertyIds, usePropertyNameMap } from '../hooks/useFilteredPropertyIds'
import {
  useBrokerage, buildEngagements, BROKERAGE_EXPIRING_DAYS, TYPE_LABEL,
  type BrokerageDoc, type BrokerageLifecycle, type Engagement, type EngagementCategory,
} from '../hooks/useBrokerage'
import { WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'

// ── M&J Wilkow corporate palette (wilkow.com) — see ReceivablesPage ─────────
const WILKOW      = '#466371'
const WILKOW_MIST = '#8fa2ad'
const SERIF       = "'Frank Ruhl Libre', 'Cinzel', Georgia, serif"

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

// Lifecycle presentation, most urgent first.
const LIFECYCLE: Record<BrokerageLifecycle, { label: string; rank: number; color: string; bg: string; border: string }> = {
  expiring:   { label: 'Expiring',        rank: 0, color: 'var(--amber)',      bg: 'var(--amber-bg)',  border: 'var(--amber-border)' },
  active:     { label: 'Active',          rank: 1, color: 'var(--green)',      bg: 'var(--green-bg)',  border: 'var(--green-border)' },
  evergreen:  { label: 'Runs until terminated', rank: 2, color: WILKOW_MIST,   bg: 'var(--surface-2)', border: 'var(--border-2)' },
  expired:    { label: 'Expired',         rank: 3, color: 'var(--red)',        bg: 'var(--red-bg)',    border: 'var(--red-border)' },
  unknown:    { label: 'No term on file', rank: 4, color: 'var(--text-muted)', bg: 'var(--surface-2)', border: 'var(--border-2)' },
  terminated: { label: 'Terminated',      rank: 5, color: 'var(--text-faint)', bg: 'var(--surface-2)', border: 'var(--border-2)' },
}

// The screen splits into two sections — exclusive leasing engagements (the
// primary points of consideration) first, then tenant-specific commissions.
const CATEGORY_META: { key: EngagementCategory; title: string; blurb: string }[] = [
  { key: 'exclusive',  title: 'Exclusive Leasing Agreements', blurb: 'Property-wide leasing appointments and their amendments — the current or most recent leasing broker at each center, newest first.' },
  { key: 'commission', title: 'Commission Agreements',        blurb: 'Tenant-specific commission agreements and deal letters.' },
]

export function BrokeragePage() {
  const { data: properties } = useProperties()
  const propertyIds = useFilteredPropertyIds(properties ?? null)
  const propertyNames = usePropertyNameMap(properties ?? null)
  const { data, loading, error } = useBrokerage(propertyIds, propertyNames)
  const docs = data ?? []

  const [lifecycleFilter, setLifecycleFilter] = useState<BrokerageLifecycle | null>(null)
  const [search, setSearch] = useState('')

  const todayIso = new Date().toISOString().slice(0, 10)
  const horizonIso = isoDaysFromNow(BROKERAGE_EXPIRING_DAYS)

  const engagements = useMemo(
    () => buildEngagements(docs, todayIso, horizonIso),
    [docs, todayIso, horizonIso])

  const counts = useMemo(() => {
    const c: Record<BrokerageLifecycle, number> = { expiring: 0, active: 0, evergreen: 0, expired: 0, unknown: 0, terminated: 0 }
    for (const e of engagements) c[e.lifecycle]++
    return c
  }, [engagements])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return engagements
      .filter(e => !lifecycleFilter || e.lifecycle === lifecycleFilter)
      .filter(e => !q
        || e.broker.toLowerCase().includes(q)
        || (e.tenant ?? '').toLowerCase().includes(q)
        || (e.governing.commissionSummary ?? '').toLowerCase().includes(q))
      .sort((a, b) =>
        LIFECYCLE[a.lifecycle].rank - LIFECYCLE[b.lifecycle].rank
        || (a.endDate ?? '9999').localeCompare(b.endDate ?? '9999')
        || a.broker.localeCompare(b.broker))
  }, [engagements, lifecycleFilter, search])

  // Two top-level sections; within each, a single flat list sorted most-recent
  // to oldest by date (property is shown on each card, not as a sub-header).
  const sections = useMemo(() => {
    return CATEGORY_META.map(cat => {
      const items = visible
        .filter(e => e.category === cat.key)
        .sort((a, b) =>
          b.sortDate.localeCompare(a.sortDate)
          || a.propertyName.localeCompare(b.propertyName)
          || a.broker.localeCompare(b.broker))
      return { ...cat, count: items.length, items }
    })
  }, [visible])

  return (
    <div style={{ padding: '26px 32px 48px', maxWidth: 1080 }}>
      {/* ── corporate header ── */}
      <div style={{ borderBottom: `2px solid ${WILKOW}`, paddingBottom: 16, marginBottom: 18 }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.28em', textTransform: 'uppercase', color: WILKOW_MIST, marginBottom: 6 }}>
          M&amp;J Wilkow · Leasing
        </div>
        <div style={{ fontFamily: SERIF, fontSize: 27, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--text)', lineHeight: 1.15 }}>
          Brokerage Agreements
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6 }}>
          Leasing engagements and commission agreements abstracted from the executed documents — one card
          per broker relationship; the latest amendment governs and the full paper trail folds underneath.
        </div>
      </div>

      {/* ── lifecycle chips (click to filter) ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {(Object.keys(LIFECYCLE) as BrokerageLifecycle[])
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
                title={k === 'expiring' ? `Term ends within ${BROKERAGE_EXPIRING_DAYS} days` : undefined}
              >
                {c.label} · {counts[k]}
              </button>
            )
          })}
        <span style={{ flex: 1 }} />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search brokers / tenants…"
          style={{ fontSize: 12, padding: '5px 10px', borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)', width: 190 }}
        />
      </div>

      {loading && <WidgetSkeleton rows={8} />}
      {error && <EmptyState title="Couldn't load brokerage agreements" subtitle={error} />}
      {!loading && !error && docs.length === 0 && (
        <EmptyState icon="🤝" title="No brokerage agreements" subtitle="Run scripts/extract_brokerage_agreements.ps1 (then -Load), or adjust the property filter" />
      )}
      {!loading && !error && docs.length > 0 && visible.length === 0 && (
        <EmptyState icon="🔍" title="Nothing matches the current filters" subtitle="Clear the lifecycle / search filters above" />
      )}

      {sections.filter(s => s.count > 0).map(section => (
        <div key={section.key} style={{ marginBottom: 34 }}>
          {/* ── category header ── */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, borderBottom: `1px solid ${WILKOW}`, paddingBottom: 8, marginBottom: 16 }}>
            <span style={{ fontFamily: SERIF, fontSize: 19, fontWeight: 600, color: 'var(--text)' }}>{section.title}</span>
            <span style={{ fontSize: 11, fontWeight: 650, color: WILKOW_MIST }}>· {section.count}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 11.5, color: 'var(--text-faint)', maxWidth: 440, textAlign: 'right', lineHeight: 1.4 }}>{section.blurb}</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {section.items.map(e => <EngagementCard key={e.key} e={e} todayIso={todayIso} />)}
          </div>
        </div>
      ))}
    </div>
  )
}

function EngagementCard({ e, todayIso }: { e: Engagement; todayIso: string }) {
  const [showTrail, setShowTrail] = useState(false)
  const g = e.governing
  const lc = LIFECYCLE[e.lifecycle]
  const accent = e.lifecycle === 'expired' ? 'var(--red)'
    : e.lifecycle === 'expiring' ? 'var(--amber)'
    : e.lifecycle === 'terminated' ? 'var(--border-2)'
    : WILKOW

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: `3px solid ${accent}`, borderRadius: 12, padding: '14px 18px', opacity: e.lifecycle === 'terminated' ? 0.82 : 1 }}>
      {/* property eyebrow */}
      <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: WILKOW_MIST, marginBottom: 6 }}>
        {e.propertyName}
      </div>
      {/* title row */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: SERIF, fontSize: 15.5, fontWeight: 600, color: 'var(--text)' }}>{e.broker}</span>
        <span style={{ fontSize: 10.5, fontWeight: 650, letterSpacing: '0.1em', textTransform: 'uppercase', color: WILKOW_MIST }}>
          {e.engagementLabel}{e.tenant ? ` · ${e.tenant}` : ''}
        </span>
        <span style={{ flex: 1 }} />
        {e.endDate && <ExpiryBlurb endDate={e.endDate} lifecycle={e.lifecycle} autoRenews={!!g.autoRenews} todayIso={todayIso} />}
        <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 10px', borderRadius: 99, background: lc.bg, color: lc.color, border: `1px solid ${lc.border}`, whiteSpace: 'nowrap' }}>
          {lc.label}
        </span>
      </div>

      {g.description && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 7, lineHeight: 1.55 }}>
          {g.agreementType !== 'exclusive_leasing' && g.agreementType !== 'cooperating_broker' && g.agreementType !== 'commission' && (
            <span style={{ fontWeight: 650, color: 'var(--text)' }}>Governing: {TYPE_LABEL[g.agreementType]} — </span>
          )}
          {g.description}
        </div>
      )}

      {/* facts row */}
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginTop: 9 }}>
        {g.termSummary && <Fact label="Term">{g.termSummary}</Fact>}
        {!g.termSummary && (g.startDate || e.endDate) && (
          <Fact label="Term">{`${fmtDate(g.startDate) ?? '—'} → ${fmtDate(e.endDate) ?? 'open'}`}</Fact>
        )}
        {g.cancelNoticeDays != null && <Fact label="Cancel notice">{`${g.cancelNoticeDays} days`}</Fact>}
        {g.agreementDate && <Fact label="Dated">{fmtDate(g.agreementDate)!}</Fact>}
      </div>

      {g.commissionSummary && (
        <div style={{ marginTop: 9, padding: '7px 11px', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 8, fontSize: 11.5, color: 'var(--text)', lineHeight: 1.5 }}>
          <span style={factLbl}>Commission</span>{g.commissionSummary}
        </div>
      )}

      {e.terminated && (
        <div style={{ marginTop: 9, padding: '7px 11px', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 8, fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          <span style={factLbl}>Terminated</span>
          {fmtDate(e.terminated.agreementDate) ?? ''} {e.terminated.description ?? ''}
        </div>
      )}

      {g.notes && (
        <div style={{ marginTop: 9, padding: '7px 11px', background: 'var(--amber-bg)', border: '1px solid var(--amber-border)', borderRadius: 8, fontSize: 11.5, color: 'var(--text)', lineHeight: 1.5 }}>
          {g.notes}
        </div>
      )}

      {/* document link + paper trail */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
        <DocChip d={g} label="View governing document" />
        {e.trail.length > 0 && (
          <button
            onClick={() => setShowTrail(s => !s)}
            style={{ fontSize: 10.5, padding: '3px 10px', borderRadius: 99, cursor: 'pointer', border: '1px solid var(--border-2)', color: 'var(--text-muted)', background: 'transparent' }}
          >
            {showTrail ? '▾' : '▸'} {e.trail.length} related document{e.trail.length === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {showTrail && e.trail.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {e.trail.map(d => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 10px', background: 'var(--surface-2)', borderRadius: 7, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: WILKOW_MIST, whiteSpace: 'nowrap' }}>
                {TYPE_LABEL[d.agreementType]}
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                {fmtDate(d.agreementDate ?? d.startDate) ?? 'undated'}
                {d.description ? ` — ${d.description}` : ''}
              </span>
              <span style={{ flex: 1 }} />
              <DocChip d={d} label="View" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** "ends in 42 d · Aug 16, 2026" next to the badge. */
function ExpiryBlurb({ endDate, lifecycle, autoRenews, todayIso }: { endDate: string; lifecycle: BrokerageLifecycle; autoRenews: boolean; todayIso: string }) {
  if (lifecycle === 'terminated') return null
  const d = daysUntil(endDate, todayIso)
  // A confirmed-active engagement whose last filed term has lapsed is either
  // continuing month-to-month (auto-renews) or on holdover pending a new
  // agreement — either way, show that, not a contradictory "ended".
  if (lifecycle === 'active' && d < 0) {
    return (
      <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
        {autoRenews ? `month-to-month · since ${fmtDate(endDate)}` : `holdover · latest term to ${fmtDate(endDate)}`}
      </span>
    )
  }
  const txt = d < 0 ? `ended ${fmtDate(endDate)}`
    : d === 0 ? 'ends today'
    : `ends in ${d} d · ${fmtDate(endDate)}`
  return (
    <span style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', color: d < 0 ? 'var(--red)' : d <= BROKERAGE_EXPIRING_DAYS ? 'var(--amber)' : 'var(--text-faint)', whiteSpace: 'nowrap' }}>
      {txt}
    </span>
  )
}

/** Opens the source document in document search when the corpus holds it;
 *  otherwise falls back to a copy-the-file-server-path chip (proven /services pattern). */
function DocChip({ d, label }: { d: BrokerageDoc; label: string }) {
  const [copied, setCopied] = useState(false)
  if (d.docTitle) {
    return (
      <Link
        to={`/documents?q=${encodeURIComponent(d.docTitle.slice(0, 140))}`}
        title={d.filePath ? `File server: ${d.filePath}` : 'Open in document search'}
        style={{ fontSize: 10.5, padding: '3px 10px', borderRadius: 99, textDecoration: 'none', border: '1px solid var(--border-2)', color: 'var(--accent)', background: 'var(--surface-2)' }}
      >
        📄 {label}
      </Link>
    )
  }
  if (!d.filePath) return null
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(d.filePath!).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1600)
        })
      }}
      title={`Copy file-server path:\n${d.filePath}`}
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
