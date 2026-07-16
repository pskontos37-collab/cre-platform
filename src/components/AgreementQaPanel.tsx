import { useState } from 'react'

// Verification verdict surfaces for agreement-verify results (PMAs on
// /management, service contracts on /services; REA/JV shapes are identical).
// Renders the qa_status pill + a collapsed findings panel: flagged
// field_checks (verdict / severity / note / verbatim quote), tracker
// reconciliation, and recommended fixes. Auto-opens when status is 'issues'.
// Same visual vocabulary as the lease-abstract QA panel so verification
// reads identically everywhere in the app.

const QA_META: Record<string, { label: string; color: string; bg: string }> = {
  verified: { label: '✓ verified', color: 'var(--green, #22c55e)', bg: 'rgba(34,197,94,0.12)' },
  issues:   { label: '⚠ issues',   color: 'var(--red, #ef4444)',   bg: 'rgba(239,68,68,0.12)' },
  review:   { label: '● review',   color: 'var(--amber)',           bg: 'rgba(245,158,11,0.12)' },
}

const VERDICT_META: Record<string, { color: string; label: string }> = {
  confirmed:    { color: 'var(--green, #22c55e)', label: 'Confirmed' },
  discrepancy:  { color: 'var(--red, #ef4444)',   label: 'Discrepancy' },
  unsupported:  { color: 'var(--red, #ef4444)',   label: 'Unsupported' },
  needs_source: { color: 'var(--amber)',           label: 'Needs source' },
}

export function AgreementQaBadge({ status }: { status: string | null | undefined }) {
  const m = status ? QA_META[status] : null
  if (!m) return null
  return (
    <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 8px', borderRadius: 10, color: m.color, background: m.bg, whiteSpace: 'nowrap' }}>
      {m.label}
    </span>
  )
}

export function AgreementQaPanel({ qa, qaStatus, qaAt }: {
  qa: any; qaStatus: string | null | undefined; qaAt: string | null | undefined
}) {
  const [open, setOpen] = useState(qaStatus === 'issues')
  if (!qa) return null
  const checks: any[] = Array.isArray(qa.field_checks) ? qa.field_checks : []
  const flagged = checks.filter(c => c?.verdict && c.verdict !== 'confirmed')
  const recon: any[] = Array.isArray(qa.tracker_reconciliation) ? qa.tracker_reconciliation : []
  const fixes: string[] = Array.isArray(qa.recommended_fixes) ? qa.recommended_fixes : []
  const stale = qa.amendment_currency?.current === false
  const nFindings = flagged.length + recon.length + fixes.length

  return (
    <div style={{ marginTop: 9, padding: '8px 11px', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
          Document verification
        </span>
        <AgreementQaBadge status={qaStatus} />
        {qaAt && <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>checked {new Date(qaAt).toLocaleDateString()}</span>}
        {nFindings > 0 && (
          <button onClick={() => setOpen(o => !o)}
            style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 600, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            {open ? 'Hide findings ▾' : `Show findings ▸ (${nFindings})`}
          </button>
        )}
      </div>
      {qa.summary && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5, marginTop: 4 }}>{qa.summary}</div>}
      {stale && (
        <div style={{ fontSize: 11.5, color: 'var(--red, #ef4444)', fontWeight: 600, marginTop: 4 }}>
          ⚠ Latest-amendment terms may not be reflected{qa.amendment_currency?.note ? ` — ${qa.amendment_currency.note}` : ''}
        </div>
      )}
      {open && (
        <div style={{ marginTop: 6 }}>
          {flagged.map((c, i) => {
            const vm = VERDICT_META[c.verdict] ?? { color: 'var(--text-muted)', label: c.verdict }
            return (
              <div key={i} style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 9.5, fontWeight: 700, color: vm.color, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{vm.label}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)' }}>{c.field}</span>
                  {c.severity && <span style={{ fontSize: 9.5, color: 'var(--text-faint)' }}>({c.severity})</span>}
                </div>
                {c.note && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>{c.note}</div>}
                {c.source_quote && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, paddingLeft: 8, borderLeft: '2px solid var(--border-2)', fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>
                    “{c.source_quote}”{c.citation ? <span style={{ fontStyle: 'normal', color: 'var(--text-faint)' }}> — {c.citation}</span> : null}
                  </div>
                )}
              </div>
            )
          })}
          {recon.length > 0 && (
            <div style={{ paddingTop: 6, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
                Tracker reconciliation ({recon.length})
              </div>
              {recon.map((m, i) => (
                <div key={i} style={{ padding: '4px 0' }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)' }}>{m.field}</span>
                  {m.governs && <span style={{ fontSize: 9.5, fontWeight: 700, marginLeft: 6, color: m.governs === 'abstract' ? 'var(--red, #ef4444)' : 'var(--text-faint)' }}>
                    {m.governs === 'abstract' ? 'documents govern — update tracker' : m.governs === 'tracker' ? 'tracker correct' : 'unclear'}
                  </span>}
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>
                    Documents: {String(m.abstract_value ?? '—')} · Tracker: {String(m.tracker_value ?? '—')}
                  </div>
                  {m.note && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1, lineHeight: 1.45 }}>{m.note}</div>}
                </div>
              ))}
            </div>
          )}
          {fixes.length > 0 && (
            <div style={{ paddingTop: 6, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Recommended fixes</div>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {fixes.map((x, i) => <li key={i} style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 2 }}>{x}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
