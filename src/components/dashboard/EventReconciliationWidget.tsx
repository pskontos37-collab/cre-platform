import { useState } from 'react'
import { Widget, WidgetSkeleton, WidgetPropertyChip, usePropertyChip, ExpandToggle } from '../ui/Widget'
import { Badge } from '../ui/Badge'
import { EmptyState } from '../ui/EmptyState'
import { useEventReconciliation, type EventReconRow } from '../../hooks/useDashboard'

// Option-date reconciliation (critical-event ledger, P1d). Surfaces option-notice
// deadlines whose STORED value disagrees with the DETERMINISTIC computation
// (expiration - notice_days). These are candidate stale dates — most dangerously,
// notice dates never updated after a term extension (the Starbucks / Kay Jewelers
// failure the audit called out). Read-only: a human adjudicates; the ledger does
// not overwrite either value.

const COLLAPSED = 5

const fmtGap = (days: number | null): string => {
  if (days == null) return ''
  const a = Math.abs(days)
  if (a >= 365) { const y = (a / 365).toFixed(a >= 730 ? 0 : 1); return `~${y} yr off` }
  return `${a} day${a === 1 ? '' : 's'} off`
}

// Severity by how far the stored value is from the computed one: years = real
// stale date; months = worth review; a few days = usually a days-vs-months or
// leap-year definitional nuance, not necessarily an error.
function gapVariant(days: number | null): 'red' | 'amber' | 'gray' {
  const a = Math.abs(days ?? 0)
  if (a >= 180) return 'red'
  if (a >= 30) return 'amber'
  return 'gray'
}

interface Props { propertyIds: string[]; propertyNames: Record<string, string> }

export function EventReconciliationWidget({ propertyIds, propertyNames }: Props) {
  const [expanded, setExpanded] = useState(false)
  const { sel, setSel, effectiveIds } = usePropertyChip(propertyIds)
  const { data, loading, error } = useEventReconciliation(effectiveIds, propertyNames)

  const rows = data ?? []
  const visible = expanded ? rows : rows.slice(0, COLLAPSED)

  return (
    <Widget
      title="Option Date Reconciliation"
      chip={
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {rows.length > 0 && <Badge variant={rows.some(r => gapVariant(r.dayGap) === 'red') ? 'red' : 'amber'}>{rows.length} to review</Badge>}
          {propertyIds.length > 1 && (
            <WidgetPropertyChip scopeIds={propertyIds} propertyNames={propertyNames} value={sel} onChange={setSel} />
          )}
        </span>
      }
    >
      {loading && <WidgetSkeleton rows={3} />}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {!loading && !error && rows.length === 0 && (
        <EmptyState icon="✓" title="No option-date discrepancies" subtitle="Every computed option-notice deadline matches the stored value" />
      )}
      {!loading && !error && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', padding: '0 2px 4px', lineHeight: 1.45 }}>
            The stored notice date differs from the deterministic computation (expiration − notice days). Review each — a large gap usually means a date never updated after a term change.
          </div>
          {visible.map((row: EventReconRow) => (
            <div
              key={row.id}
              style={{
                padding: '9px 11px', background: 'var(--surface-2)', borderRadius: 7,
                border: `1px solid ${gapVariant(row.dayGap) === 'red' ? 'var(--red-border)' : gapVariant(row.dayGap) === 'amber' ? 'var(--amber-border)' : 'var(--border-2)'}`,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', lineHeight: 1.4, wordBreak: 'break-word' }}>{row.title}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 2 }}>{row.propertyName}</div>
                </div>
                <Badge variant={gapVariant(row.dayGap)}>{fmtGap(row.dayGap)}</Badge>
              </div>
              <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 11 }}>
                <span>
                  <span style={{ color: 'var(--text-faint)' }}>Computed </span>
                  <span style={{ color: 'var(--green)', fontWeight: 600 }}>{row.computedDate}</span>
                </span>
                <span>
                  <span style={{ color: 'var(--text-faint)' }}>Stored </span>
                  <span style={{ color: 'var(--text-muted)', fontWeight: 600, textDecoration: 'line-through' }}>{row.mriValue ?? '—'}</span>
                </span>
              </div>
              {row.formula && (
                <div style={{ fontSize: 9.5, color: 'var(--text-faint)', marginTop: 4, fontFamily: 'var(--font-mono, monospace)' }}>{row.formula}</div>
              )}
            </div>
          ))}
          <ExpandToggle expanded={expanded} onToggle={() => setExpanded(e => !e)} collapsedCount={COLLAPSED} totalCount={rows.length} />
        </div>
      )}
    </Widget>
  )
}
