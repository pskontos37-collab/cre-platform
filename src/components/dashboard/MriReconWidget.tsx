import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Widget, WidgetSkeleton } from '../ui/Widget'
import { EmptyState } from '../ui/EmptyState'
import { useAuth } from '../../contexts/AuthContext'
import { supabase } from '../../lib/supabase'
import { useQuery } from '../../hooks/useQuery'

// "MRI Reconciliation" — the dashboard cut of /mri-recon, sitting next to Open
// Work Orders. Surfaces every open field where the lease documents and the MRI
// system-of-record disagree (from the abstract QA layer), so managers see what
// still needs to be addressed. Triage / status changes happen on /mri-recon.

interface MriReconWidgetProps {
  propertyIds: string[]
  propertyNames: Record<string, string>
}

interface ReconRow {
  property_id: string
  property_name: string
  tenant_name: string
  field: string
  abstract_value: string | null
  mri_value: string | null
  governs: string
}
interface StatusRow {
  property_id: string
  tenant_name: string
  field: string
  status: string
}

// Items no longer needing attention.
const CLOSED = new Set(['resolved', 'not_an_issue'])

// governs is the triage key: abstract -> docs govern, the MRI record is
// wrong/stale (fix MRI); mri -> MRI is right, the abstract is wrong (fix on
// /abstracts); unclear -> human adjudication needed.
const GOVERNS_META: Record<string, { label: string; short: string; color: string; rank: number }> = {
  abstract: { label: 'MRI record wrong', short: 'Fix MRI',   color: 'var(--red)',        rank: 0 },
  mri:      { label: 'Abstract wrong',   short: 'Fix abstr', color: 'var(--amber)',      rank: 1 },
  unclear:  { label: 'Adjudicate',       short: 'Adjudicate', color: 'var(--text-muted)', rank: 2 },
}

const COLLAPSED = 5
const stKey = (r: { property_id: string; tenant_name: string; field: string }) =>
  `${r.property_id}|${r.tenant_name}|${r.field}`

export function MriReconWidget({ propertyIds, propertyNames }: MriReconWidgetProps) {
  const { appUser } = useAuth()
  const canView = appUser?.role === 'admin' || appUser?.role === 'asset_manager'

  const recon = useQuery<ReconRow[]>(async () => {
    if (!canView) return []
    const { data, error } = await supabase
      .from('v_mri_reconciliation')
      .select('property_id, property_name, tenant_name, field, abstract_value, mri_value, governs')
      .limit(2000)
    if (error) throw new Error(error.message)
    return (data ?? []) as ReconRow[]
  }, [canView])

  const statuses = useQuery<StatusRow[]>(async () => {
    if (!canView) return []
    const { data, error } = await supabase
      .from('mri_recon_status')
      .select('property_id, tenant_name, field, status')
    if (error) throw new Error(error.message)
    return (data ?? []) as StatusRow[]
  }, [canView])

  const scope = useMemo(() => new Set(propertyIds), [propertyIds])
  const stMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const s of statuses.data ?? []) m.set(stKey(s), s.status)
    return m
  }, [statuses.data])

  // Open = in scope and not resolved/not_an_issue (absent status defaults open).
  const open = useMemo(() => (recon.data ?? [])
    .filter(r => scope.size === 0 || scope.has(r.property_id))
    .filter(r => !CLOSED.has(stMap.get(stKey(r)) ?? 'open'))
    .sort((a, b) =>
      (GOVERNS_META[a.governs]?.rank ?? 9) - (GOVERNS_META[b.governs]?.rank ?? 9) ||
      a.property_name.localeCompare(b.property_name) ||
      a.tenant_name.localeCompare(b.tenant_name)),
  [recon.data, scope, stMap])

  const counts = useMemo(() => {
    const c: Record<string, number> = { abstract: 0, mri: 0, unclear: 0 }
    for (const r of open) c[r.governs] = (c[r.governs] ?? 0) + 1
    return c
  }, [open])

  const loading = recon.loading || statuses.loading
  const error = recon.error || statuses.error
  // A flag, not a workspace: only ever show the first few; the rest is a count
  // that routes to /mri-recon for the full list and triage.
  const visible = open.slice(0, COLLAPSED)
  const overflow = open.length - visible.length

  return (
    <Widget
      title="MRI Reconciliation"
      href="/mri-recon"
      hrefLabel="Reconcile →"
      chip={open.length > 0 ? `${open.length} open` : undefined}
    >
      {!canView && (
        <EmptyState icon="🔒" title="Admin / asset manager only" subtitle="MRI reconciliation is restricted" />
      )}
      {canView && loading && <WidgetSkeleton rows={3} />}
      {canView && error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {canView && !loading && !error && open.length === 0 && (
        <EmptyState icon="✅" title="No open conflicts" subtitle="Documents and MRI agree across the portfolio" />
      )}

      {canView && !loading && !error && open.length > 0 && (
        <>
          {/* stat rail — actionable buckets keyed to who fixes what */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
            <Stat label="open" value={open.length} />
            {counts.abstract > 0 && <Stat label="fix MRI" value={counts.abstract} color="var(--red)" />}
            {counts.mri > 0 && <Stat label="fix abstract" value={counts.mri} color="var(--amber)" />}
            {counts.unclear > 0 && <Stat label="adjudicate" value={counts.unclear} color="var(--text-muted)" />}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {visible.map((r, i) => {
              const g = GOVERNS_META[r.governs] ?? GOVERNS_META.unclear
              return (
                <div key={`${stKey(r)}-${i}`} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 9,
                  padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 7,
                  border: `1px solid ${r.governs === 'abstract' ? 'var(--red-border, var(--red))' : 'var(--border-2)'}`,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 600, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.tenant_name}
                      <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}> · {r.field}</span>
                    </div>
                    <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 3, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                      <span>{propertyNames[r.property_id] ?? r.property_name}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>
                        docs: {r.abstract_value ?? '—'} → MRI: {r.mri_value ?? '—'}
                      </span>
                    </div>
                  </div>
                  <span style={{
                    fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', flexShrink: 0,
                    color: g.color, border: `1px solid ${g.color}`, borderRadius: 999, padding: '1px 7px', marginTop: 1,
                  }} title={g.label}>
                    {g.short}
                  </span>
                </div>
              )
            })}
            {overflow > 0 && (
              <Link to="/mri-recon" style={{
                marginTop: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                fontSize: 11, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none',
                padding: '7px 0', borderRadius: 7, border: '1px dashed var(--border-2)',
              }}>
                +{overflow.toLocaleString()} more to reconcile →
              </Link>
            )}
          </div>
        </>
      )}
    </Widget>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'baseline', gap: 5,
      padding: '3px 9px', borderRadius: 999, background: 'var(--surface-2)',
      border: '1px solid var(--border-2)',
    }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: color ?? 'var(--text)' }}>{value}</span>
      <span style={{ fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-faint)' }}>{label}</span>
    </span>
  )
}
