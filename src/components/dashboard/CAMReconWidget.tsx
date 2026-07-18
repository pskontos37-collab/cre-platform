import { useState, useRef } from 'react'
import { Widget, WidgetSkeleton } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useCAMRecon, type CAMReconRow } from '../../hooks/useDashboard'
import { supabase } from '../../lib/supabase'

const fmtDollar = (n: number | null) =>
  n != null ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : '—'

interface CAMReconWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
  // When set, only this many rows show initially with a "Show all" toggle —
  // used on the Financials page where the full list is rarely needed.
  previewCount?: number
}

const STATUS_BADGE: Record<string, 'amber' | 'red' | 'gray' | 'blue'> = {
  in_progress: 'blue',
  overdue:     'red',
  disputed:    'amber',
}

const STATUS_LABEL: Record<string, string> = {
  in_progress: 'In Progress',
  overdue:     'Overdue',
  disputed:    'Disputed',
}

const TYPE_LABEL: Record<string, string> = { cam: 'CAM', ins: 'INS', ret: 'RET' }

export function CAMReconWidget({ propertyIds, propertyNames, previewCount }: CAMReconWidgetProps) {
  const { data, loading, error, refetch } = useCAMRecon(propertyIds, propertyNames)
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [expanded, setExpanded] = useState(false)
  // The pending-confirm target: a single row id, or a `group:<key>` sentinel for
  // a bulk close. A second click on the same target commits.
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  // Row ids optimistically hidden while their status update is in flight.
  const [completing, setCompleting] = useState<Set<string>>(new Set())
  const [saveError, setSaveError] = useState<string | null>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Arm a button for its confirming second click. Auto-disarms after 4s so a
  // stale "Confirm" state can't linger — but never on mouseleave (the armed
  // label is wider, so the button reflows under the cursor and would instantly
  // fire mouseleave, disarming before the second click could land).
  function arm(key: string) {
    setConfirmKey(key)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    confirmTimer.current = setTimeout(() => setConfirmKey(null), 4000)
  }

  async function commitComplete(ids: string[]) {
    if (!ids.length) return
    setConfirmKey(null)
    setSaveError(null)
    setCompleting(prev => { const n = new Set(prev); ids.forEach(i => n.add(i)); return n })
    // Ask PostgREST to return the rows it actually updated (.select()) so we can
    // VERIFY the write rather than trusting the optimistic hide. An RLS-filtered or
    // partial update returns fewer rows with NO error — previously indistinguishable
    // from success, which let the board show a false "done" while the DB was untouched.
    const { data: updated, error: upErr } = await supabase
      .from('cam_reconciliations')
      .update({
        status:         'complete',
        completed_date: new Date().toISOString().slice(0, 10),
        updated_at:     new Date().toISOString(),
      })
      .in('id', ids)
      .select('id')

    const okIds = new Set(((updated ?? []) as { id: string }[]).map(r => r.id))
    if (upErr || okIds.size !== ids.length) {
      // Re-show every row that did NOT actually change; keep any that genuinely did.
      setCompleting(prev => {
        const n = new Set(prev)
        ids.forEach(i => { if (!okIds.has(i)) n.delete(i) })
        return n
      })
      setSaveError(
        upErr
          ? upErr.message
          : `only ${okIds.size} of ${ids.length} saved — the rest were blocked and left open`,
      )
      refetch()
      return
    }
    refetch()
  }

  const all = (data ?? []).filter(r => !completing.has(r.id))
  const typesPresent = Array.from(new Set(all.map(r => r.recType)))
  const filtered = typeFilter === 'all' ? all : all.filter(r => r.recType === typeFilter)
  const collapsed = previewCount != null && !expanded && filtered.length > previewCount
  const rows = collapsed ? filtered.slice(0, previewCount) : filtered

  // Group the VISIBLE rows by property + year + type, preserving first-seen order.
  // Bulk "Mark all" acts on the full group in `filtered` (not just the visible
  // slice) so a collapsed group still closes completely — but never crosses into
  // another year/type, so a freshly-loaded year can't be swept up by accident.
  const groupKey = (r: CAMReconRow) => `${r.propertyName} ${r.periodYear} ${r.recType}`
  const groups: { key: string; label: string; rows: CAMReconRow[]; allIds: string[] }[] = []
  const groupIndex = new Map<string, number>()
  for (const r of rows) {
    const k = groupKey(r)
    let idx = groupIndex.get(k)
    if (idx == null) {
      idx = groups.length
      groupIndex.set(k, idx)
      groups.push({
        key: k,
        label: `${r.propertyName} · ${r.periodYear} · ${TYPE_LABEL[r.recType] ?? r.recType}`,
        rows: [],
        allIds: filtered.filter(f => groupKey(f) === k).map(f => f.id),
      })
    }
    groups[idx].rows.push(r)
  }
  const multiGroup = groups.length > 1

  return (
    <Widget title="Expense Reconciliations" chip={all.length > 0 ? `${all.length} open` : undefined}>
      {loading && <WidgetSkeleton rows={3} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && all.length === 0 && (
        <EmptyState icon="✅" title="No open reconciliations" subtitle="All CAM / INS / RET recons are complete" />
      )}
      {saveError && (
        <div style={{ fontSize: 11, color: 'var(--red)', marginBottom: 4 }}>
          Couldn't mark reconciled: {saveError}
        </div>
      )}
      {!loading && !error && all.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {typesPresent.length > 1 && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 2 }}>
              {['all', ...typesPresent].map(t => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(t)}
                  style={{
                    fontSize: 10,
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: `1px solid ${typeFilter === t ? 'var(--accent)' : 'var(--border-2)'}`,
                    background: typeFilter === t ? 'var(--accent-dim)' : 'transparent',
                    color: typeFilter === t ? 'var(--accent)' : 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                >
                  {t === 'all' ? `All (${all.length})` : `${TYPE_LABEL[t] ?? t} (${all.filter(r => r.recType === t).length})`}
                </button>
              ))}
            </div>
          )}
          {groups.map(group => {
            const groupConfirm = `group:${group.key}`
            return (
            <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {/* Group header + bulk close — shown when there's more than one
                  property/year/type group so a single year can't be swept up. */}
              {multiGroup && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 2 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                    {group.label}
                  </div>
                  <button
                    onClick={() => (confirmKey === groupConfirm ? commitComplete(group.allIds) : arm(groupConfirm))}
                    title={`Mark all ${group.allIds.length} reconciliations in ${group.label} complete`}
                    style={{
                      fontSize: 9.5,
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: 999,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                      border: `1px solid ${confirmKey === groupConfirm ? 'var(--green)' : 'var(--border-2)'}`,
                      background: confirmKey === groupConfirm ? 'var(--green)' : 'transparent',
                      color: confirmKey === groupConfirm ? '#fff' : 'var(--text-muted)',
                    }}
                  >
                    {confirmKey === groupConfirm ? `Confirm — close ${group.allIds.length} ✓` : `✓ Mark all (${group.allIds.length})`}
                  </button>
                </div>
              )}
              {group.rows.map(row => (
                <div
                  key={row.id}
                  style={{
                    display:   'grid',
                    gridTemplateColumns: '1fr 80px 80px 80px 108px',
                    gap:       8,
                    alignItems:'center',
                    padding:   '7px 10px',
                    background:'var(--surface-2)',
                    borderRadius: 7,
                    border:    `1px solid ${row.status === 'overdue' ? 'var(--red-border)' : 'var(--border-2)'}`,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {row.tenantName ?? 'Unknown'}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                      {row.propertyName} · {row.periodYear} · {TYPE_LABEL[row.recType] ?? row.recType}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 9, color: 'var(--text-faint)' }}>Billed</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtDollar(row.estimatedAmount)}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 9, color: 'var(--text-faint)' }}>Actual</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{fmtDollar(row.actualAmount)}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 9, color: 'var(--text-faint)' }}>True-up</div>
                    <div style={{
                      fontSize: 11,
                      fontWeight: row.variance != null && Math.abs(row.variance) > 0 ? 600 : 400,
                      color: row.variance == null ? 'var(--text-faint)' : row.variance > 0 ? 'var(--amber)' : 'var(--green)',
                      fontVariantNumeric: 'tabular-nums',
                    }}>
                      {row.variance != null ? (row.variance > 0 ? '+' : '') + fmtDollar(row.variance) : '—'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                    <Badge variant={STATUS_BADGE[row.status] ?? 'gray'}>
                      {STATUS_LABEL[row.status] ?? row.status}
                    </Badge>
                    <button
                      onClick={() => (confirmKey === row.id ? commitComplete([row.id]) : arm(row.id))}
                      title="Close out this reconciliation and remove it from the board"
                      style={{
                        fontSize: 9.5,
                        fontWeight: 600,
                        padding: '2px 7px',
                        borderRadius: 999,
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        border: `1px solid ${confirmKey === row.id ? 'var(--green)' : 'var(--border-2)'}`,
                        background: confirmKey === row.id ? 'var(--green)' : 'transparent',
                        color: confirmKey === row.id ? '#fff' : 'var(--text-muted)',
                      }}
                    >
                      {confirmKey === row.id ? 'Confirm ✓' : '✓ Mark reconciled'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            )
          })}
          {/* Single-group bulk close — when everything on screen is one
              property/year/type, offer a footer "mark all" instead of a header. */}
          {!multiGroup && groups.length === 1 && groups[0].allIds.length > 1 && (() => {
            const g = groups[0]
            const gc = `group:${g.key}`
            return (
              <button
                onClick={() => (confirmKey === gc ? commitComplete(g.allIds) : arm(gc))}
                title={`Mark all ${g.allIds.length} reconciliations in ${g.label} complete`}
                style={{
                  marginTop: 3,
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '6px 0',
                  borderRadius: 7,
                  cursor: 'pointer',
                  border: `1px ${confirmKey === gc ? 'solid' : 'dashed'} ${confirmKey === gc ? 'var(--green)' : 'var(--border-2)'}`,
                  background: confirmKey === gc ? 'var(--green)' : 'transparent',
                  color: confirmKey === gc ? '#fff' : 'var(--text-muted)',
                }}
              >
                {confirmKey === gc ? `Confirm — close all ${g.allIds.length} ✓` : `✓ Mark all ${g.allIds.length} reconciled (${g.label})`}
              </button>
            )
          })()}
          {previewCount != null && filtered.length > previewCount && (
            <button
              onClick={() => setExpanded(e => !e)}
              style={{
                marginTop: 3,
                fontSize: 11,
                fontWeight: 600,
                padding: '6px 0',
                borderRadius: 7,
                border: '1px dashed var(--border-2)',
                background: 'transparent',
                color: 'var(--accent)',
                cursor: 'pointer',
              }}
            >
              {expanded ? '▲ Show fewer' : `▼ Show all ${filtered.length}`}
            </button>
          )}
        </div>
      )}
    </Widget>
  )
}
