import { useState, type CSSProperties, type ReactNode } from 'react'
import {
  type Transaction, type TxnDoc, type VerificationStatus,
  TXN_TYPE_LABEL, DEBT_EVENT_LABEL, figureLabel, roleLabel, docCompleteness,
} from '../../hooks/useTransactions'

// Shared presentation for the transactions record — used by both the /transactions
// ledger and the per-property timeline on PropertyDetailPage. Certainty is the
// theme: every figure carries a citation, every doc shows searchable/viewable
// state + provenance, and completeness is displayed, not assumed.

const WILKOW_MIST = '#8fa2ad'
const SERIF = "'Frank Ruhl Libre', 'Cinzel', Georgia, serif"

const fmt$c = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const fmtDate = (iso: string | null) => {
  if (!iso) return null
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
const baseName = (p: string | null) => (p ? p.split(/[\\/]/).pop() ?? '' : '')

// ── Verification badge (reuses the abstract-QA grammar) ──────────────────────
const VERIF: Record<VerificationStatus, { label: string; color: string; bg: string; border: string }> = {
  verified:   { label: '✓ Verified',   color: 'var(--green)',      bg: 'var(--green-bg)',  border: 'var(--green-border)' },
  issues:     { label: '! Issues',     color: 'var(--red)',        bg: 'var(--red-bg)',    border: 'var(--red-border)' },
  unverified: { label: 'Unverified',   color: 'var(--text-muted)', bg: 'var(--surface-2)', border: 'var(--border-2)' },
}
export function VerificationBadge({ status }: { status: VerificationStatus }) {
  const v = VERIF[status]
  return <span style={chip(v.color, v.bg, v.border)}>{v.label}</span>
}

const TYPE_COLOR: Record<string, string> = {
  acquisition: 'var(--green)', disposition: 'var(--amber)',
  refinance: WILKOW_MIST, recap: 'var(--accent)',
}
export function TypeBadge({ t }: { t: Transaction }) {
  const c = TYPE_COLOR[t.type] ?? 'var(--text-muted)'
  const debt = t.debtEvent ? ` · ${DEBT_EVENT_LABEL[t.debtEvent] ?? t.debtEvent}` : ''
  return <span style={{ ...chip(c, 'transparent', 'var(--border-2)'), fontWeight: 700 }}>{TXN_TYPE_LABEL[t.type]}{debt}</span>
}

function chip(color: string, bg: string, border: string): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600,
    color, background: bg, border: `1px solid ${border}`, borderRadius: 99, padding: '1px 8px', whiteSpace: 'nowrap',
  }
}

// ── One document row — the certainty surface ─────────────────────────────────
function DocRow({ d }: { d: TxnDoc }) {
  const canView = d.viewable && d.signedUrl
  const href = d.signedUrl ?? undefined
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderTop: '1px solid var(--border)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, fontWeight: d.isKey ? 700 : 500, color: 'var(--text)' }}>{roleLabel(d.role)}</span>
          {d.isKey && <span style={chip('var(--accent)', 'var(--accent-dim)', 'transparent')}>key</span>}
          {d.sensitivity === 'restricted' && <span style={chip('var(--amber)', 'var(--amber-bg)', 'var(--amber-border)')}>🔒 restricted</span>}
          {/* two independent guarantees */}
          <span title="Full text is indexed for search" style={miniBadge(d.searchable)}>🔍 {d.searchable ? 'searchable' : 'not indexed'}</span>
          <span title="A PDF is available to open right now" style={miniBadge(d.viewable)}>📄 {d.viewable ? 'viewable' : 'no file'}</span>
          {d.fingerprintDrift && <span title="The stored file changed since it was linked — re-verify" style={chip('var(--amber)', 'var(--amber-bg)', 'var(--amber-border)')}>⚠ changed</span>}
          {d.superseded && <span title="A newer version of this document exists" style={chip('var(--amber)', 'var(--amber-bg)', 'var(--amber-border)')}>⚠ superseded</span>}
        </div>
        {(d.title || d.filePath) && (
          <div title={d.filePath ?? undefined} style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {baseName(d.filePath) || d.title}
          </div>
        )}
      </div>
      {canView ? (
        <a href={href} target="_blank" rel="noopener noreferrer"
          style={{ ...chip('var(--accent)', 'var(--accent-dim)', 'transparent'), textDecoration: 'none', fontWeight: 700 }}>
          View PDF ↗
        </a>
      ) : (
        <span title={d.searchable ? 'Indexed but the PDF is not in the storage mirror yet' : 'Not yet ingested from the source folder'}
          style={{ ...chip('var(--text-faint)', 'var(--surface-2)', 'var(--border-2)'), cursor: 'not-allowed' }}>
          No PDF
        </span>
      )}
    </div>
  )
}

function miniBadge(on: boolean): CSSProperties {
  return chip(on ? 'var(--green)' : 'var(--text-faint)', on ? 'var(--green-bg)' : 'var(--surface-2)', on ? 'var(--green-border)' : 'var(--border-2)')
}

// ── Figures with citations ───────────────────────────────────────────────────
function Figures({ t }: { t: Transaction }) {
  if (!t.figures.length) return null
  const docById = new Map(t.docs.map(d => [d.documentId, d]))
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 4 }}>
      {t.figures.map(f => {
        const cite = f.documentId ? docById.get(f.documentId) : undefined
        const href = cite?.viewable ? (f.pageNumber && cite.signedUrl ? `${cite.signedUrl}#page=${f.pageNumber}` : cite.signedUrl) : null
        return (
          <div key={f.label} style={{ minWidth: 130 }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
              {figureLabel(f.label)}{f.basis === 'preliminary' ? ' ≈' : ''}
            </div>
            <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>{fmt$c(f.value)}</div>
            {f.documentId && (
              href ? (
                <a href={href} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: 'var(--accent)', textDecoration: 'none' }}>
                  ↳ {roleLabel(cite?.role ?? null)}{f.pageNumber ? `, p.${f.pageNumber}` : ''}
                </a>
              ) : (
                <span title="Cited document not viewable yet" style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                  ↳ {roleLabel(cite?.role ?? null)} (no PDF)
                </span>
              )
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Completeness banner (the third certainty axis) ───────────────────────────
function Completeness({ t }: { t: Transaction }) {
  const c = docCompleteness(t)
  const parts: ReactNode[] = []
  if (c.manifestCount != null) {
    const gap = c.manifestCount - c.linked
    parts.push(<span key="m">{c.manifestCount} in source folder</span>)
    parts.push(<span key="l">· {c.linked} linked</span>)
    if (gap > 0) parts.push(<span key="g" style={{ color: 'var(--amber)' }}>· {gap} source file{gap === 1 ? '' : 's'} not linked</span>)
  } else {
    parts.push(<span key="nm" style={{ color: 'var(--text-faint)' }}>source folder not scanned yet</span>)
    parts.push(<span key="l2">· {c.linked} linked</span>)
  }
  parts.push(<span key="k">· {c.key} key</span>)
  parts.push(<span key="v">· {c.viewable} viewable</span>)
  return (
    <div style={{ fontSize: 10.5, color: 'var(--text-muted)', display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 2 }}>
      {parts}
    </div>
  )
}

// ── The card (used by both surfaces) ─────────────────────────────────────────
export function TransactionCard({ t, showProperty = true, defaultOpen = false }: {
  t: Transaction; showProperty?: boolean; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const keyDocs = t.docs.filter(d => d.isKey)
  const otherDocs = t.docs.filter(d => !d.isKey)
  const otherProps = t.properties.filter(p => !p.isPrimary)

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, background: 'var(--surface)', padding: 12, marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <TypeBadge t={t} />
            <VerificationBadge status={t.verificationStatus} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmtDate(t.closeDate)}</span>
          </div>
          {showProperty && (
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginTop: 5 }}>
              {t.primaryPropertyName ?? '—'}
              {otherProps.length > 0 && (
                <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--text-faint)' }}> + {otherProps.map(p => p.name).join(', ')}</span>
              )}
            </div>
          )}
          {t.counterparty && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{t.counterparty}</div>}
        </div>
      </div>

      <Figures t={t} />

      {t.narrative && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5, marginTop: 8 }}>{t.narrative}</div>
      )}

      <div style={{ marginTop: 8 }}>
        <Completeness t={t} />
        <button onClick={() => setOpen(o => !o)}
          style={{ marginTop: 6, background: 'none', border: 'none', color: 'var(--accent)', fontSize: 11.5, fontWeight: 600, cursor: 'pointer', padding: 0 }}>
          {open ? '▾ Hide documents' : `▸ Documents (${t.docs.length})`}
        </button>
        {open && (
          <div style={{ marginTop: 4 }}>
            {t.docs.length === 0 && (
              <div style={{ fontSize: 11.5, color: 'var(--text-faint)', padding: '6px 0' }}>
                No documents linked yet{t.sourceFolderPath ? ` — source: ${t.sourceFolderPath}` : ''}.
              </div>
            )}
            {keyDocs.length > 0 && (
              <div style={{ marginTop: 2 }}>
                <div style={sectionLabel}>Key documents</div>
                {keyDocs.map(d => <DocRow key={d.documentId} d={d} />)}
              </div>
            )}
            {otherDocs.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div style={sectionLabel}>Full binder</div>
                {otherDocs.map(d => <DocRow key={d.documentId} d={d} />)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const sectionLabel: CSSProperties = {
  fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 2,
}
