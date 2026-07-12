import { useMemo, useState, type CSSProperties } from 'react'
import { useProperties } from '../hooks/useProperties'
import { useFilteredPropertyIds, usePropertyNameMap } from '../hooks/useFilteredPropertyIds'
import {
  useCoiCertificates, STATUS_META, PARTY_META,
  type CoiCertificate, type CoiStatus, type PartyType,
} from '../hooks/useCoi'
import { WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'

// ── M&J Wilkow corporate palette — matches the other ops pages ──
const WILKOW      = '#466371'
const WILKOW_MIST = '#8fa2ad'
const SERIF       = "'Frank Ruhl Libre', 'Cinzel', Georgia, serif"

// KPI cards, in the order a risk manager triages: unprotected first.
const KPI_ORDER: CoiStatus[] = ['missing', 'expired', 'deficient', 'expiring', 'compliant']

type PartyFilter = 'all' | PartyType

export function InsurancePage() {
  const { data: properties } = useProperties()
  const propertyIds = useFilteredPropertyIds(properties ?? null)
  const propertyNames = usePropertyNameMap(properties ?? null)
  const { data, loading, error } = useCoiCertificates(propertyIds)
  const certs = data ?? []

  const [partyFilter, setPartyFilter] = useState<PartyFilter>('all')
  const [statusFilter, setStatusFilter] = useState<CoiStatus | null>(null)
  const [search, setSearch] = useState('')

  const statusCounts = useMemo(() => {
    const c = {} as Record<CoiStatus, number>
    for (const k of KPI_ORDER) c[k] = 0
    for (const cert of certs) c[cert.status] = (c[cert.status] ?? 0) + 1
    return c
  }, [certs])

  const partyCounts = useMemo(() => {
    const c = { all: certs.length, tenant: 0, vendor: 0, contractor: 0 } as Record<PartyFilter, number>
    for (const cert of certs) c[cert.partyType] = (c[cert.partyType] ?? 0) + 1
    return c
  }, [certs])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return certs
      .filter(c => partyFilter === 'all' || c.partyType === partyFilter)
      .filter(c => !statusFilter || c.status === statusFilter)
      .filter(c => !q || [c.partyName, c.insuredContact, c.insuredEmail, c.producerName, c.ebixVendorNum]
        .some(v => v?.toLowerCase().includes(q)))
  }, [certs, partyFilter, statusFilter, search])

  // property → parties
  const byProperty = useMemo(() => {
    const props = new Map<string, CoiCertificate[]>()
    for (const c of visible) {
      const pName = propertyNames[c.propertyId] ?? '—'
      if (!props.has(pName)) props.set(pName, [])
      props.get(pName)!.push(c)
    }
    const rank: Record<CoiStatus, number> = { missing: 0, expired: 1, deficient: 2, expiring: 3, pending: 4, compliant: 5 }
    return Array.from(props.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([pName, list]) => ({
        propertyName: pName,
        parties: [...list].sort((a, b) => (rank[a.status] - rank[b.status]) || a.partyName.localeCompare(b.partyName)),
      }))
  }, [visible, propertyNames])

  return (
    <div style={{ padding: '26px 32px 48px', maxWidth: 1120 }}>
      {/* header */}
      <div style={{ marginBottom: 4 }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.28em', textTransform: 'uppercase', color: WILKOW_MIST, marginBottom: 6 }}>
          M&amp;J Wilkow · Risk &amp; Insurance
        </div>
        <div style={{ fontFamily: SERIF, fontSize: 27, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--text)', lineHeight: 1.15 }}>
          Certificates of Insurance
        </div>
      </div>

      {/* seed provenance note */}
      <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '10px 0 18px', maxWidth: 820 }}>
        Tenant &amp; vendor COI compliance across the portfolio. This view is seeded from the latest
        Ebix report, so <b>status and deficiencies</b> are current as of that export; per-coverage
        limits, policy numbers and expiration dates populate as certificates are parsed from the
        ACORD PDFs. Missing / expired / deficient parties are the collection worklist.
      </div>

      {/* KPI row */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 18 }}>
        {KPI_ORDER.map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(statusFilter === s ? null : s)}
            style={{
              flex: '1 1 150px', minWidth: 140, textAlign: 'left', cursor: 'pointer',
              background: 'var(--surface)', borderRadius: 12, padding: '13px 16px',
              border: `1px solid ${statusFilter === s ? STATUS_META[s].color : 'var(--border)'}`,
              borderLeft: `3px solid ${STATUS_META[s].color}`,
              boxShadow: statusFilter === s ? `0 0 0 1px ${STATUS_META[s].color}` : 'none',
            }}
          >
            <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--text)', lineHeight: 1 }}>{statusCounts[s]}</div>
            <div style={{ fontSize: 11, fontWeight: 650, letterSpacing: '0.04em', textTransform: 'uppercase', color: STATUS_META[s].color, marginTop: 6 }}>
              {STATUS_META[s].label}
            </div>
          </button>
        ))}
      </div>

      {/* party tabs + search */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        {(['all', 'tenant', 'vendor', 'contractor'] as PartyFilter[]).filter(p => p === 'all' || partyCounts[p] > 0).map(p => {
          const on = partyFilter === p
          const label = p === 'all' ? 'All' : PARTY_META[p as PartyType].label + 's'
          return (
            <button
              key={p}
              onClick={() => setPartyFilter(p)}
              style={{
                fontSize: 11.5, fontWeight: 650, padding: '5px 12px', borderRadius: 99, cursor: 'pointer',
                background: on ? WILKOW : 'var(--surface-2)', color: on ? '#fff' : 'var(--text-muted)',
                border: `1px solid ${on ? WILKOW : 'var(--border-2)'}`,
              }}
            >
              {label} · {partyCounts[p]}
            </button>
          )
        })}
        {statusFilter && (
          <button onClick={() => setStatusFilter(null)} style={{ ...linkBtn, color: WILKOW }}>
            ✕ clear “{STATUS_META[statusFilter].label}” filter
          </button>
        )}
        <span style={{ flex: 1 }} />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search party, contact, broker…"
          style={{ fontSize: 12, padding: '5px 10px', borderRadius: 7, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)', width: 220 }}
        />
      </div>

      {loading && <WidgetSkeleton rows={8} />}
      {error && <EmptyState title="Couldn't load certificates" subtitle={error} />}
      {!loading && !error && certs.length === 0 && (
        <EmptyState icon="🛡" title="No certificates yet"
          subtitle="Seed the tracker with scripts/load_ebix.ps1, or parse ACORD PDFs via the coi-extract pipeline" />
      )}
      {!loading && !error && certs.length > 0 && visible.length === 0 && (
        <EmptyState icon="🔍" title="Nothing matches" subtitle="Clear the filters or search above" />
      )}

      {byProperty.map(prop => (
        <div key={prop.propertyName} style={{ marginBottom: 26 }}>
          <div style={{ fontSize: 10.5, fontWeight: 650, letterSpacing: '0.18em', textTransform: 'uppercase', color: WILKOW_MIST, marginBottom: 10 }}>
            {prop.propertyName}
            <span style={{ color: 'var(--text-faint)', letterSpacing: 0 }}> · {prop.parties.length} part{prop.parties.length === 1 ? 'y' : 'ies'}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {prop.parties.map(c => <PartyRow key={c.id} c={c} />)}
          </div>
        </div>
      ))}
    </div>
  )
}

function PartyRow({ c }: { c: CoiCertificate }) {
  const sc = STATUS_META[c.status]
  const party = PARTY_META[c.partyType]
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: `3px solid ${sc.color}`, borderRadius: 10, padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{c.partyName}</span>
        <span title={party.label} style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{party.icon} {party.label}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: sc.color, background: 'var(--surface-2)', border: `1px solid ${sc.color}`, borderRadius: 5, padding: '1px 7px' }}>
          {sc.label}
        </span>
      </div>

      {c.deficiencies.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {c.deficiencies.map((d, i) => (
            <span key={i} style={{ fontSize: 11, color: 'var(--text)', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6, padding: '2px 8px' }}>
              {d.label}
            </span>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8, fontSize: 11.5, color: 'var(--text-muted)' }}>
        {c.expirationDate && <span>Expires <b style={{ color: 'var(--text)' }}>{c.expirationDate}</b></span>}
        {c.amBestRating && <span>A.M. Best {c.amBestRating}</span>}
        {(c.insuredContact || c.insuredEmail) && (
          <span>
            {c.insuredContact ? c.insuredContact + ' ' : ''}
            {c.insuredEmail && <a href={`mailto:${c.insuredEmail}`} style={{ color: WILKOW }}>{c.insuredEmail}</a>}
          </span>
        )}
        {c.producerName && <span>Broker: {c.producerName}{c.producerPhone ? ` · ${c.producerPhone}` : ''}</span>}
        {c.ebixVendorNum && <span style={{ color: 'var(--text-faint)' }}>Ebix {c.ebixVendorNum}</span>}
      </div>
    </div>
  )
}

const linkBtn: CSSProperties = { fontSize: 11.5, fontWeight: 600, padding: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }
