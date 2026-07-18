import { useMemo } from 'react'
import { Widget, WidgetSkeleton } from '../ui/Widget'
import { EmptyState } from '../ui/EmptyState'
import { Hero } from '../ui/Kpi'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { useQuery } from '../../hooks/useQuery'

// "MRI Reconciliation" — the dashboard cut of /mri-recon, sitting next to Open
// Work Orders. A compact flag: how many open fields where the lease documents
// and the MRI system-of-record disagree (from the abstract QA layer) still need
// attention, split by who fixes what. Managers drill into /mri-recon to work
// the list.

interface MriReconWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

interface ReconRow {
  property_id: string
  tenant_name: string
  field: string
  governs: string
}
interface StatusRow {
  property_id: string
  tenant_name: string
  field: string
  status: string
  reflagged_at: string | null   // set when a newer QA run reopened a resolved row
}

// Items no longer needing attention.
const CLOSED = new Set(['resolved', 'not_an_issue'])

// governs is the triage key: abstract -> docs govern, the MRI record is
// wrong/stale (fix MRI); mri -> MRI is right, the abstract is wrong (fix on
// /abstracts); unclear -> human adjudication needed.
const BUCKETS: Array<{ key: string; label: string; color: string }> = [
  { key: 'abstract', label: 'Fix MRI',      color: 'var(--red)' },
  { key: 'mri',      label: 'Fix abstract', color: 'var(--amber)' },
  { key: 'unclear',  label: 'Adjudicate',   color: 'var(--text-muted)' },
]

const stKey = (r: { property_id: string; tenant_name: string; field: string }) =>
  `${r.property_id}|${r.tenant_name}|${r.field}`

export function MriReconWidget({ propertyIds }: MriReconWidgetProps) {
  const { appUser } = useAuth()
  const canView = appUser?.role === 'admin' || appUser?.role === 'asset_manager'

  const recon = useQuery<ReconRow[]>(async () => {
    if (!canView) return []
    const { data, error } = await supabase
      .from('v_mri_reconciliation')
      .select('property_id, tenant_name, field, governs')
      .limit(2000)
    if (error) throw new Error(error.message)
    return (data ?? []) as ReconRow[]
  }, [canView])

  const statuses = useQuery<StatusRow[]>(async () => {
    if (!canView) return []
    // Reopen any resolved/not_an_issue row re-flagged by a newer QA run, so the open
    // count here matches /mri-recon even when nobody has opened that page. No-op when
    // nothing is stale.
    await supabase.rpc('revert_stale_mri_recon')
    const { data, error } = await supabase
      .from('mri_recon_status')
      .select('property_id, tenant_name, field, status, reflagged_at')
    if (error) throw new Error(error.message)
    return (data ?? []) as StatusRow[]
  }, [canView])

  const scope = useMemo(() => new Set(propertyIds), [propertyIds])
  const stMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of statuses.data ?? []) m.set(stKey(s), s.status)
    return m
  }, [statuses.data])
  const reflaggedKeys = useMemo(() => {
    const s = new Set<string>()
    for (const st of statuses.data ?? []) if (st.reflagged_at) s.add(stKey(st))
    return s
  }, [statuses.data])

  // Open = in scope and not resolved/not_an_issue (absent status defaults open).
  const counts = useMemo(() => {
    const c: Record<string, number> = { abstract: 0, mri: 0, unclear: 0, total: 0, reflagged: 0 }
    for (const r of recon.data ?? []) {
      if (scope.size > 0 && !scope.has(r.property_id)) continue
      if (CLOSED.has(stMap.get(stKey(r)) ?? 'open')) continue
      c[r.governs] = (c[r.governs] ?? 0) + 1
      c.total++
      if (reflaggedKeys.has(stKey(r))) c.reflagged++
    }
    return c
  }, [recon.data, scope, stMap, reflaggedKeys])

  const loading = recon.loading || statuses.loading
  const error = recon.error || statuses.error

  return (
    <Widget title="MRI Reconciliation" href="/mri-recon" hrefLabel="Reconcile →">
      {!canView && (
        <EmptyState icon="🔒" title="Admin / asset manager only" subtitle="MRI reconciliation is restricted" />
      )}
      {canView && loading && <WidgetSkeleton rows={3} />}
      {canView && error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {canView && !loading && !error && counts.total === 0 && (
        <EmptyState icon="✅" title="No open conflicts" subtitle="Documents and MRI agree across the portfolio" />
      )}

      {canView && !loading && !error && counts.total > 0 && (
        <>
          <Hero label="Open conflicts" value={counts.total.toLocaleString()} />
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1,
            background: 'var(--border)', border: '1px solid var(--border)', borderRadius: 10,
            overflow: 'hidden', marginTop: 12,
          }}>
            {BUCKETS.map(b => (
              <div key={b.key} style={{ background: 'var(--surface)', padding: '10px 12px' }}>
                <div style={{ fontSize: 9.5, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 3 }}>
                  {b.label}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: b.color, fontVariantNumeric: 'tabular-nums' }}>
                  {(counts[b.key] ?? 0).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
          {counts.reflagged > 0 && (
            <div title="Conflicts you had resolved that a newer QA run flagged again — re-check on /mri-recon"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 12, padding: '3px 10px', borderRadius: 10,
                fontSize: 11, fontWeight: 700, color: 'var(--amber)', background: 'color-mix(in srgb, var(--amber) 15%, transparent)',
                border: '1px solid var(--amber)' }}>
              ↻ {counts.reflagged.toLocaleString()} re-flagged since resolved
            </div>
          )}
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 10, lineHeight: 1.5 }}>
            Fields where the lease documents and the MRI system-of-record disagree.
          </div>
        </>
      )}
    </Widget>
  )
}
