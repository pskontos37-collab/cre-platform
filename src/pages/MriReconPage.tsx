import { useMemo, useState } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { useQuery } from '../hooks/useQuery'
import { Widget, WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'

// /mri-recon — the MRI reconciliation QUEUE. v_mri_reconciliation (from the
// abstract QA layer) lists every abstract-vs-MRI conflict; mri_recon_status adds
// workflow state per (property, tenant, field). `governs` is the triage key:
//   abstract -> the documents control; the MRI RECORD is wrong/stale (fix MRI)
//   mri      -> MRI is right; the ABSTRACT is wrong (fix via Review & correct)
//   unclear  -> human adjudication needed

interface ReconRow {
  property_id: string
  property_name: string
  tenant_name: string
  field: string
  abstract_value: string | null
  mri_value: string | null
  governs: string
  note: string | null
  qa_at: string
}
interface StatusRow {
  id: string
  property_id: string
  tenant_name: string
  field: string
  status: string
  note: string | null
}

const STATUSES = ['open', 'in_progress', 'resolved', 'not_an_issue']
const GOVERNS_META: Record<string, { label: string; color: string }> = {
  abstract: { label: 'MRI record wrong', color: 'var(--red, #ef4444)' },
  mri: { label: 'Abstract wrong', color: 'var(--amber)' },
  unclear: { label: 'Adjudicate', color: 'var(--text-muted)' },
}

export function MriReconPage() {
  const { appUser } = useAuth()
  const [bump, setBump] = useState(0)
  const [governs, setGoverns] = useState('abstract')
  const [statusFilter, setStatusFilter] = useState('open')
  const [propFilter, setPropFilter] = useState('')

  const recon = useQuery<ReconRow[]>(async () => {
    const { data, error } = await supabase.from('v_mri_reconciliation').select('*').limit(2000)
    if (error) throw new Error(error.message)
    return (data ?? []) as ReconRow[]
  }, [])
  const statuses = useQuery<StatusRow[]>(async () => {
    const { data, error } = await supabase.from('mri_recon_status').select('id, property_id, tenant_name, field, status, note')
    if (error) throw new Error(error.message)
    return (data ?? []) as StatusRow[]
  }, [bump])

  const stKey = (r: { property_id: string; tenant_name: string; field: string }) => `${r.property_id}|${r.tenant_name}|${r.field}`
  const stMap = useMemo(() => {
    const m = new Map<string, StatusRow>()
    for (const s of statuses.data ?? []) m.set(stKey(s), s)
    return m
  }, [statuses.data])

  const props = useMemo(() => [...new Set((recon.data ?? []).map(r => r.property_name))].sort(), [recon.data])

  const rows = useMemo(() => (recon.data ?? [])
    .filter(r => (!governs || r.governs === governs))
    .filter(r => (!propFilter || r.property_name === propFilter))
    .filter(r => {
      const st = stMap.get(stKey(r))?.status ?? 'open'
      return !statusFilter || st === statusFilter
    })
    .sort((a, b) => a.property_name.localeCompare(b.property_name) || a.tenant_name.localeCompare(b.tenant_name)),
  [recon.data, governs, propFilter, statusFilter, stMap])

  if (appUser?.role !== 'admin' && appUser?.role !== 'asset_manager') {
    return <div style={{ padding: '40px 32px', color: 'var(--text-muted)', fontSize: 14 }}>You need admin or asset manager access to view MRI reconciliation.</div>
  }

  async function setStatus(r: ReconRow, status: string, note?: string) {
    const existing = stMap.get(stKey(r))
    const patch: any = { status, updated_by: appUser?.id ?? null, updated_at: new Date().toISOString() }
    if (note !== undefined) patch.note = note || null
    if (existing) {
      await supabase.from('mri_recon_status').update(patch).eq('id', existing.id)
    } else {
      await supabase.from('mri_recon_status').insert({ property_id: r.property_id, tenant_name: r.tenant_name, field: r.field, ...patch })
    }
    setBump(b => b + 1)
  }

  function exportCsv() {
    const esc = (s: any) => `"${String(s ?? '').replace(/"/g, '""')}"`
    const head = 'property,tenant,field,abstract_value,mri_value,governs,status,note'
    const lines = rows.map(r => [r.property_name, r.tenant_name, r.field, r.abstract_value, r.mri_value, r.governs, stMap.get(stKey(r))?.status ?? 'open', r.note].map(esc).join(','))
    const blob = new Blob([[head, ...lines].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'mri_reconciliation.csv'
    a.click()
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { abstract: 0, mri: 0, unclear: 0 }
    for (const r of recon.data ?? []) c[r.governs] = (c[r.governs] ?? 0) + 1
    return c
  }, [recon.data])

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>MRI Reconciliation</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18 }}>
        Every field where the lease documents and the MRI system-of-record disagree, found by the abstract QA layer.
        “MRI record wrong” means the documents govern — fix the MRI record; “Abstract wrong” routes to Review &amp; correct on /abstracts.
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        {Object.entries(GOVERNS_META).map(([k, m]) => (
          <button key={k} onClick={() => setGoverns(governs === k ? '' : k)}
            style={{ padding: '5px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', fontWeight: governs === k ? 700 : 400,
              border: `1px solid ${governs === k ? m.color : 'var(--border)'}`, background: governs === k ? 'var(--surface-2)' : 'transparent', color: m.color }}>
            {m.label} ({counts[k] ?? 0})
          </button>
        ))}
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '6px 9px' }}>
          <option value="">Any status</option>
          {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <select value={propFilter} onChange={e => setPropFilter(e.target.value)}
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6, color: 'var(--text)', fontSize: 12, padding: '6px 9px' }}>
          <option value="">All properties</option>
          {props.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <button onClick={exportCsv}
          style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer' }}>
          Export CSV ({rows.length})
        </button>
      </div>

      <Widget title="Conflicts" chip={`${rows.length} shown`} fullWidth>
        {recon.loading && <WidgetSkeleton rows={10} />}
        {!recon.loading && rows.length === 0 && <EmptyState title="Nothing in this filter" subtitle="Adjust the governs/status filters above" />}
        {rows.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead><tr style={{ textAlign: 'left', color: 'var(--text-faint)', fontSize: 11 }}>
              <th style={{ padding: '4px 8px' }}>Property</th><th style={{ padding: '4px 8px' }}>Tenant</th>
              <th style={{ padding: '4px 8px' }}>Field</th><th style={{ padding: '4px 8px' }}>Abstract / docs</th>
              <th style={{ padding: '4px 8px' }}>MRI</th><th style={{ padding: '4px 8px', width: 130 }}>Status</th>
            </tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const st = stMap.get(stKey(r))
                return (
                  <tr key={i} style={{ borderTop: '1px solid var(--border)', verticalAlign: 'top' }}>
                    <td style={{ padding: '6px 8px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{r.property_name}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text)', fontWeight: 600 }}>{r.tenant_name}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{r.field}
                      {r.note && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2, maxWidth: 380 }}>{r.note}</div>}
                    </td>
                    <td style={{ padding: '6px 8px', color: 'var(--text)' }}>{r.abstract_value ?? '—'}</td>
                    <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{r.mri_value ?? '—'}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <select value={st?.status ?? 'open'} onChange={e => void setStatus(r, e.target.value)}
                        style={{ width: '100%', background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 5, color: 'var(--text)', fontSize: 11, padding: '3px 6px' }}>
                        {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                      </select>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Widget>
    </div>
  )
}
