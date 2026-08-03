import { useState } from 'react'
import { Widget, WidgetSkeleton, ExpandToggle } from './ui/Widget'
import { CHECK_LABEL, DataQualityFinding, useDataQuality } from '../hooks/useDataQuality'

// Standing data-quality report for one property (migration 20240181).
//
// The 8/01-8/02 sweeps found real defects by hand-running SQL. Every one of those
// checks is deterministic over data we already store, so it costs nothing to run
// and should not depend on someone remembering to run it. This widget is where a
// property shows its defects on day one instead of months later, when someone
// finally reads the PDF.
//
// Findings are keyed to the same resolution model as the Review Center
// (abstract_item_resolutions), so an item settled there reads as settled here.

const SEV_COLOR: Record<string, string> = {
  discrepancy: 'var(--red, #ef4444)',
  confirm:     'var(--amber)',
  info:        'var(--text-faint)',
}
const SEV_ICON: Record<string, string> = { discrepancy: '✕', confirm: '⚑', info: 'i' }

function Group({ code, rows }: { code: string; rows: DataQualityFinding[] }) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const meta = CHECK_LABEL[code] ?? { title: code, why: '' }
  const sev = rows[0]?.severity ?? 'info'
  const shown = expanded ? rows : rows.slice(0, 5)
  return (
    <div style={{ borderTop: '1px solid var(--border-2)', paddingTop: 8, marginTop: 8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left',
          background: 'none', border: 'none', padding: 0, cursor: 'pointer', outline: 'none',
        }}
      >
        <span style={{ color: SEV_COLOR[sev], fontSize: 11, fontWeight: 700, flex: 'none' }}>{SEV_ICON[sev]}</span>
        <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--text)', flex: 1 }}>{meta.title}</span>
        <span style={{ fontSize: 10.5, color: 'var(--text-faint)', flex: 'none' }}>
          {rows.length}{rows.some(r => r.resolved) ? ` · ${rows.filter(r => r.resolved).length} settled` : ''} {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 6 }}>
          {meta.why && (
            <div style={{ fontSize: 10.5, color: 'var(--text-faint)', lineHeight: 1.6, marginBottom: 8 }}>
              {meta.why}
            </div>
          )}
          {shown.map((r, i) => (
            <div key={`${r.abstract_id ?? r.item_key}-${i}`}
                 style={{ marginBottom: 7, opacity: r.resolved ? 0.5 : 1 }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text)' }}>
                {r.tenant_name ?? 'Property-level'}
                {r.resolved && (
                  <span style={{ fontSize: 9.5, fontWeight: 600, color: 'var(--green)', marginLeft: 6 }}>
                    {r.resolution_status ?? 'resolved'}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.55 }}>{r.detail}</div>
            </div>
          ))}
          <ExpandToggle expanded={expanded} onToggle={() => setExpanded(e => !e)}
            collapsedCount={5} totalCount={rows.length} />
        </div>
      )}
    </div>
  )
}

export function DataQualityWidget({ propertyId }: { propertyId: string | null }) {
  const { data, loading, error } = useDataQuality(propertyId)

  const rows = (data ?? []).filter(r => !r.resolved)
  const groups = new Map<string, DataQualityFinding[]>()
  for (const r of (data ?? [])) {
    if (!groups.has(r.check_code)) groups.set(r.check_code, [])
    groups.get(r.check_code)!.push(r)
  }
  const openCount = rows.length
  const worst = rows.some(r => r.severity === 'discrepancy') ? 'discrepancy'
    : rows.some(r => r.severity === 'confirm') ? 'confirm' : 'info'

  // FAIL LOUD, never falsely green. On error `data` is null, so openCount is 0 —
  // the chip used to read "all checks clean" over a failed query, which is exactly
  // the false-green this whole day's work was about removing from the verifier.
  // A check that cannot run must say so.
  const chip = loading ? 'checking…'
    : error ? 'CHECKS DID NOT RUN'
    : openCount === 0 ? 'all checks clean'
    : `${openCount} open`

  return (
    <Widget title="DATA QUALITY" chip={chip} fullWidth>
      {loading ? <WidgetSkeleton rows={3} /> : error ? (
        <div style={{ fontSize: 11.5, color: 'var(--amber)', lineHeight: 1.6 }}>
          <strong>The standing checks could not run — this is NOT a clean result.</strong>
          <div style={{ marginTop: 4, color: 'var(--text-muted)' }}>{error}</div>
        </div>
      ) : (data ?? []).length === 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.6 }}>
          Every standing check passes for this property. These run on stored data and cost nothing,
          so this panel stays current without anyone asking it to.
        </div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.6 }}>
            Deterministic checks over stored data — no AI cost, always current.{' '}
            {openCount === 0
              ? 'Everything below has been settled in the Review Center.'
              : <>Worst open severity: <span style={{ color: SEV_COLOR[worst], fontWeight: 700 }}>{worst}</span>. Resolving an item in the Review Center settles it here too.</>}
          </div>
          {[...groups.entries()]
            .sort((a, b) => b[1].filter(r => !r.resolved).length - a[1].filter(r => !r.resolved).length)
            .map(([code, rs]) => <Group key={code} code={code} rows={rs} />)}
        </>
      )}
    </Widget>
  )
}
