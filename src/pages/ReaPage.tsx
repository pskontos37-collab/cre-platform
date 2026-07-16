import { useMemo, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { useProperties } from '../hooks/useProperties'
import { useFilteredPropertyIds, usePropertyNameMap } from '../hooks/useFilteredPropertyIds'
import { useReaAgreements, type ReaAgreement } from '../hooks/useRea'
import { WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'
import { ReaPdfButton } from '../reports/ReaPdfButton'
import { AgreementQaBadge, AgreementQaPanel } from '../components/AgreementQaPanel'
import { AgreementAbstractPanel } from '../components/AgreementAbstractPanel'
import { AgreementAbstractPdfButton } from '../reports/AgreementAbstractPdfButton'

// ── M&J Wilkow corporate palette (wilkow.com) — see ReceivablesPage ─────────
const WILKOW      = '#466371'
const WILKOW_MIST = '#8fa2ad'
const SERIF       = "'Frank Ruhl Libre', 'Cinzel', Georgia, serif"

const fmt = (n: number) => {
  const s = Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  return n < 0 ? `(${s})` : s
}

export function ReaPage() {
  const { data: properties } = useProperties()
  const propertyIds = useFilteredPropertyIds(properties ?? null)
  const propertyNames = usePropertyNameMap(properties ?? null)
  const { data, loading, error } = useReaAgreements(propertyIds, propertyNames)
  const agreements = data ?? []

  const byProperty = useMemo(() => {
    const m = new Map<string, ReaAgreement[]>()
    for (const a of agreements) {
      const list = m.get(a.propertyName) ?? []
      list.push(a)
      m.set(a.propertyName, list)
    }
    return Array.from(m.entries())
  }, [agreements])

  const openItemCount = agreements.filter(a => a.openItems).length

  return (
    <div style={{ padding: '26px 32px 48px', maxWidth: 1080 }}>
      {/* ── corporate header ── */}
      <div style={{ borderBottom: `2px solid ${WILKOW}`, paddingBottom: 16, marginBottom: 20, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16 }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.28em', textTransform: 'uppercase', color: WILKOW_MIST, marginBottom: 6 }}>
            M&amp;J Wilkow · Property Agreements
          </div>
          <div style={{ fontFamily: SERIF, fontSize: 27, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--text)', lineHeight: 1.15 }}>
            Reciprocal Easement Agreements
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6 }}>
            REA / OEA instruments, member tracts, operator obligations and cost sharing — abstracted from the recorded documents in the corpus.
            {openItemCount > 0 && <> · <b style={{ color: 'var(--amber)' }}>{openItemCount} with open items</b></>}
          </div>
        </div>
        <ReaPdfButton agreements={agreements} />
      </div>

      {loading && <WidgetSkeleton rows={8} />}
      {error && <EmptyState title="Couldn't load REAs" subtitle={error} />}
      {!loading && !error && agreements.length === 0 && (
        <EmptyState icon="📜" title="No REAs recorded" subtitle="Seed rea_agreements (scripts/seed_rea_agreements.sql) or adjust the property filter" />
      )}

      {byProperty.map(([propName, list]) => (
        <div key={propName} style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 10.5, fontWeight: 650, letterSpacing: '0.18em', textTransform: 'uppercase', color: WILKOW_MIST, marginBottom: 10 }}>
            {propName}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {list.map(a => <AgreementCard key={a.id} a={a} />)}
          </div>
        </div>
      ))}
    </div>
  )
}

function AgreementCard({ a }: { a: ReaAgreement }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: `3px solid ${WILKOW}`, borderRadius: 12, padding: '16px 20px', boxShadow: 'var(--shadow, none)' }}>
      {/* title row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontFamily: SERIF, fontSize: 16.5, fontWeight: 600, color: 'var(--text)', letterSpacing: '0.015em' }}>{a.name}</div>
          <AgreementQaBadge status={a.qaStatus} />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
          {a.agreementDate ?? ''}{a.termSummary ? ` · ${a.termSummary}` : ''}
        </div>
      </div>

      {a.operator && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
          <span style={lbl}>Operator</span> {a.operator}
        </div>
      )}

      {/* members */}
      {a.members.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={sectionLbl}>Parties &amp; Tracts</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {a.members.map((m, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 10px', background: 'var(--surface-2)', borderRadius: 7, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{m.name}</span>
                {m.role && <span style={{ fontSize: 10.5, color: WILKOW_MIST }}>{m.role}</span>}
                {m.tract && <span style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{m.tract}</span>}
                <span style={{ flex: 1 }} />
                {m.arTotal != null && (
                  <span style={{ fontSize: 11.5, fontVariantNumeric: 'tabular-nums', fontWeight: 650, color: m.arTotal < 0 ? '#65bc7b' : m.arTotal > 0 ? 'var(--amber)' : 'var(--text-faint)' }}
                    title={`A/R balance as of ${m.arAsOf} (MRI ${m.mri})`}>
                    A/R {fmt(m.arTotal)}
                  </span>
                )}
                {m.note && <span style={{ fontSize: 10.5, color: 'var(--amber)', width: '100%' }}>{m.note}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* narrative sections */}
      {a.costSharing && <Section label="Cost Sharing">{a.costSharing}</Section>}
      {a.keyProvisions && <Section label="Key Provisions">{a.keyProvisions}</Section>}
      {a.amendments && <Section label="Amendments & Consents">{a.amendments}</Section>}

      {/* abstractor-v2: the verified brief-synthesis abstract + independent
          verification verdict (agreement-abstract / agreement-verify kind=rea). */}
      {a.abstract && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <AgreementAbstractPdfButton kind="rea" name={a.name} abstract={a.abstract} qa={a.qa} qaStatus={a.qaStatus} qaAt={a.qaAt} />
          </div>
          <AgreementAbstractPanel kind="rea" abstract={a.abstract} />
        </>
      )}
      {a.qa && <AgreementQaPanel qa={a.qa} qaStatus={a.qaStatus} qaAt={a.qaAt} />}

      {a.openItems && (
        <div style={{ marginTop: 12, padding: '9px 12px', background: 'var(--amber-bg)', border: '1px solid var(--amber-border)', borderRadius: 8 }}>
          <div style={{ ...sectionLbl, color: 'var(--amber)', marginBottom: 3 }}>Open Items</div>
          <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.55 }}>{a.openItems}</div>
        </div>
      )}

      {/* source documents */}
      {a.sourceDocs.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={sectionLbl}>Source Documents</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {a.sourceDocs.map(d => (
              <Link
                key={d.id}
                to={`/documents?q=${encodeURIComponent(d.title)}`}
                style={{
                  fontSize: 10.5, padding: '3px 10px', borderRadius: 99, textDecoration: 'none',
                  border: '1px solid var(--border-2)', color: 'var(--accent)', background: 'var(--surface-2)',
                }}
                title="Open in document search"
              >
                📄 {d.title}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const lbl: CSSProperties = {
  fontSize: 9.5, fontWeight: 650, letterSpacing: '0.14em', textTransform: 'uppercase',
  color: WILKOW_MIST, marginRight: 8,
}
const sectionLbl: CSSProperties = {
  fontSize: 9.5, fontWeight: 650, letterSpacing: '0.14em', textTransform: 'uppercase',
  color: WILKOW_MIST, marginBottom: 6,
}

function Section({ label, children }: { label: string; children: string }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={sectionLbl}>{label}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>{children}</div>
    </div>
  )
}
