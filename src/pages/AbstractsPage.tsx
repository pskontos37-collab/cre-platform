import { useState, useEffect, useMemo } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useProperties } from '../hooks/useProperties'
import { useQuery } from '../hooks/useQuery'
import { supabase } from '../lib/supabase'
import { Widget, WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'
import { AbstractsExportBar } from '../reports/AbstractsExportBar'

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`

interface AbstractRow {
  id: string
  tenant_name: string
  status: string
  abstract: any
  generated_at: string
  source_doc_ids: string[] | null
  error: string | null
  qa: any
  qa_status: string | null      // verified | issues | review | null
  qa_at: string | null
  overrides: Record<string, any> | null
  human_verified: boolean
  locked: boolean
  reviewed_at: string | null
  review_note: string | null
}

function useTenantsForProperty(propertyId: string | null) {
  return useQuery<string[]>(async () => {
    if (!propertyId) return []
    // Active leases only. REA members (Kohl's, Target, PH Developers, pads…)
    // own their parcels under the REA — no lease to abstract.
    const { data: leases, error } = await supabase
      .from('leases')
      .select('status, tenants!inner(name, trade_name)')
      .eq('property_id', propertyId)
      .eq('status', 'active')
      .eq('is_rea_member', false)
    if (error) throw new Error(error.message)
    // Exclude MRI placeholder rows that are not standalone leases with their
    // own document set: additional-space allocations, available/vacant units.
    const PLACEHOLDER = /^(additional space|available|vacant)\b/i
    const names = [...new Set(((leases ?? []) as any[])
      .map(l => (l.tenants?.trade_name || l.tenants?.name || '').trim())
      .filter(n => n.length > 1 && !PLACEHOLDER.test(n)))]
    return names.sort((a, b) => a.localeCompare(b))
  }, [propertyId])
}

function useAbstracts(propertyId: string | null, bump: number) {
  return useQuery<AbstractRow[]>(async () => {
    if (!propertyId) return []
    const { data, error } = await supabase
      .from('lease_abstracts')
      .select('id, tenant_name, status, abstract, generated_at, source_doc_ids, error, qa, qa_status, qa_at, overrides, human_verified, locked, reviewed_at, review_note')
      .eq('property_id', propertyId)
    if (error) throw new Error(error.message)
    return (data ?? []) as AbstractRow[]
  }, [propertyId, bump])
}

// Clause-matrix choices: label + path into the abstract JSON.
// Exported: the portfolio-wide /clauses page reuses the same definitions.
export const CLAUSES: Array<{ key: string; label: string; render: (a: any) => string }> = [
  { key: 'co_tenancy', label: 'Co-tenancy', render: a => a?.co_tenancy?.exists ? `${a.co_tenancy.exact_language_and_remedies ?? ''}${a.co_tenancy.section ? ` [${a.co_tenancy.section}]` : ''}` : 'None' },
  { key: 'exclusives', label: 'Exclusives', render: a => a?.exclusives?.exists ? `${a.exclusives.exact_language ?? ''}${a.exclusives.section ? ` [${a.exclusives.section}]` : ''}` : 'None' },
  { key: 'percentage_rent', label: 'Percentage rent', render: a => a?.percentage_rent?.applicable ? `${a.percentage_rent.rate_pct ?? '?'}% over ${a.percentage_rent.breakpoint ?? '?'} ${a.percentage_rent.notes ?? ''}` : 'None' },
  { key: 'options', label: 'Options', render: a => (a?.options ?? []).length ? a.options.map((o: any) => `${o.term}${o.notice_period ? ` (notice ${o.notice_period})` : ''}`).join('; ') : 'None' },
  { key: 'termination_kickout', label: 'Termination / kickout', render: a => a?.termination_kickout?.exists ? `${a.termination_kickout.details ?? ''}` : 'None' },
  { key: 'radius_clause', label: 'Radius clause', render: a => a?.radius_clause?.exists ? `${a.radius_clause.details ?? ''}` : 'None' },
  { key: 'continuous_operations', label: 'Continuous operations', render: a => a?.continuous_operations?.exists ? `${a.continuous_operations.details ?? ''}` : 'None' },
  { key: 'permitted_use', label: 'Permitted use', render: a => a?.permitted_use?.exact_language ?? '—' },
  { key: 'cam_caps', label: 'CAM caps / exclusions', render: a => a?.cam?.caps_exclusions ?? '—' },
  { key: 'sales_reporting', label: 'Sales reporting', render: a => a?.sales_reporting?.reports ? `${a.sales_reporting.frequency ?? 'Yes'}` : 'Does not report' },
  { key: 'signage', label: 'Signage rights', render: a => {
    const s = a?.signage
    if (!s || (s.pylon_monument_right == null && !s.notes && !s.exhibit)) return '—'
    const parts = [
      s.pylon_monument_right === true ? 'Pylon/monument: YES' : s.pylon_monument_right === false ? 'Pylon/monument: no' : null,
      s.exhibit ? `Exhibit ${s.exhibit}` : null,
      s.notes,
    ].filter(Boolean)
    return `${parts.join(' · ')}${s.section ? ` [${s.section}]` : ''}`
  } },
]

export function AbstractsPage() {
  const { appUser } = useAuth()
  const { data: properties } = useProperties()
  const [propertyId, setPropertyId] = useState<string | null>(null)
  useEffect(() => { if (!propertyId && properties?.length) setPropertyId(properties[0].id) }, [properties, propertyId])

  const [bump, setBump] = useState(0)
  const tenants = useTenantsForProperty(propertyId)
  const abstracts = useAbstracts(propertyId, bump)
  const [selected, setSelected] = useState<string | null>(null)
  const [generating, setGenerating] = useState<Set<string>>(new Set())
  const [verifying, setVerifying] = useState<Set<string>>(new Set())
  const [genError, setGenError] = useState<string | null>(null)
  const [view, setView] = useState<'tenant' | 'clause'>('tenant')
  const [clause, setClause] = useState('co_tenancy')

  const byTenant = useMemo(() => {
    const m = new Map<string, AbstractRow>()
    for (const a of abstracts.data ?? []) m.set(a.tenant_name.toLowerCase(), a)
    return m
  }, [abstracts.data])

  if (appUser?.role !== 'admin' && appUser?.role !== 'asset_manager') {
    return <div style={{ padding: '40px 32px', color: 'var(--text-muted)', fontSize: 14 }}>You need admin or asset manager access to view lease abstracts.</div>
  }

  async function generate(tenant: string) {
    if (!propertyId || generating.has(tenant)) return
    // Never clobber a locked (human-authoritative) abstract with an AI re-run.
    if (byTenant.get(tenant.toLowerCase())?.locked) {
      setGenError(`${tenant}: abstract is locked — unlock it in "Review & correct" before regenerating.`)
      return
    }
    setGenError(null)
    setGenerating(prev => new Set(prev).add(tenant))
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${FN_BASE}/lease-abstract`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, tenant }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`)
      setBump(b => b + 1)
      setSelected(tenant)
    } catch (e) {
      setGenError(`${tenant}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setGenerating(prev => { const n = new Set(prev); n.delete(tenant); return n })
    }
  }

  // Independent QA pass: re-reads the source PDFs and adversarially checks the
  // stored abstract. Takes 1–2 min (runs on the strongest model).
  async function verify(tenant: string) {
    if (!propertyId || verifying.has(tenant)) return
    setGenError(null)
    setVerifying(prev => new Set(prev).add(tenant))
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${FN_BASE}/abstract-verify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session?.access_token ?? ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: propertyId, tenant }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json.error) throw new Error(json.error ?? `Request failed (${res.status})`)
      setBump(b => b + 1)
    } catch (e) {
      setGenError(`Verify ${tenant}: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setVerifying(prev => { const n = new Set(prev); n.delete(tenant); return n })
    }
  }

  const selectedAbstract = selected ? byTenant.get(selected.toLowerCase()) : null

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1100 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>Lease Abstracts</span>
        <AccuracyChip />
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18 }}>
        AI-generated abstracts following the firm's Lease Abstract Template — exact clause language with section
        citations, built from the lease + amendments in the document corpus. Generation takes 1–2 minutes per tenant.
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <select value={propertyId ?? ''} onChange={e => { setPropertyId(e.target.value); setSelected(null) }}
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6, color: 'var(--text)', fontSize: 13, padding: '7px 10px' }}>
          {(properties ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {/* Quick tenant selection menu (✓ = abstract exists) */}
        <select value={selected ?? ''} onChange={e => { setSelected(e.target.value || null); setView('tenant') }}
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6, color: 'var(--text)', fontSize: 13, padding: '7px 10px', maxWidth: 280 }}>
          <option value="">Select tenant…</option>
          {(tenants.data ?? []).map(t => (
            <option key={t} value={t}>{byTenant.has(t.toLowerCase()) ? '✓ ' : ''}{t}</option>
          ))}
        </select>
        <div style={{ display: 'flex', gap: 6 }}>
          <ModeButton label="By tenant" active={view === 'tenant'} onClick={() => setView('tenant')} />
          <ModeButton label="Clause matrix" active={view === 'clause'} onClick={() => setView('clause')} />
        </div>
        <GenerateAllButton
          tenants={tenants.data ?? []}
          byTenant={byTenant}
          generating={generating}
          onGenerate={generate}
        />
        <VerifyAllButton
          abstracts={abstracts.data ?? []}
          verifying={verifying}
          onVerify={verify}
        />
        {view === 'clause' && (
          <select value={clause} onChange={e => setClause(e.target.value)}
            style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6, color: 'var(--text)', fontSize: 13, padding: '7px 10px' }}>
            {CLAUSES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
        )}
        <div style={{ marginLeft: 'auto' }}>
          <AbstractsExportBar
            properties={(properties ?? []).map(p => ({ id: p.id, name: p.name }))}
            propertyId={propertyId}
            propertyName={(properties ?? []).find(p => p.id === propertyId)?.name ?? ''}
            selectedTenant={selected}
            currentAbstracts={(abstracts.data ?? []).map(r => ({ ...r, abstract: applyOverrides(r.abstract, r.overrides) }))}
          />
        </div>
      </div>

      {genError && <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 10 }}>{genError}</div>}

      <RefreshLogBanner onJump={t => { setSelected(t); setView('tenant') }} />

      {view === 'tenant' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16 }}>
          <Widget title="Tenants" chip={tenants.data ? `${tenants.data.length} active` : undefined}>
            {tenants.loading && <WidgetSkeleton rows={10} />}
            {tenants.error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{tenants.error}</div>}
            {!tenants.loading && (tenants.data ?? []).length === 0 && (
              <EmptyState title="No structured leases" subtitle="Lease model not seeded for this property yet" />
            )}
            <div style={{ display: 'flex', flexDirection: 'column', maxHeight: 560, overflowY: 'auto' }}>
              {(tenants.data ?? []).map(t => {
                const a = byTenant.get(t.toLowerCase())
                const busy = generating.has(t)
                return (
                  <div key={t}
                    onClick={() => setSelected(t)}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 8px',
                      borderRadius: 6, cursor: 'pointer',
                      background: selected === t ? 'var(--accent-dim)' : 'transparent' }}>
                    <span style={{ fontSize: 12, color: selected === t ? 'var(--accent)' : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t}</span>
                    {busy
                      ? <span style={{ fontSize: 10, color: 'var(--amber)' }}>generating…</span>
                      : verifying.has(t)
                        ? <span style={{ fontSize: 10, color: 'var(--amber)' }}>verifying…</span>
                        : a
                          ? <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{a.locked && <span title="Human-verified & locked" style={{ fontSize: 10 }}>🔒</span>}<QaBadge status={a.qa_status} /></span>
                          : <button onClick={e => { e.stopPropagation(); void generate(t) }}
                              style={{ fontSize: 10, padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                              Generate
                            </button>}
                  </div>
                )
              })}
            </div>
          </Widget>

          <div>
            {!selectedAbstract && (
              <Widget title="Abstract">
                <EmptyState icon="📄" title={selected ? 'Not generated yet' : 'Pick a tenant'}
                  subtitle={selected ? 'Click Generate on the tenant list — takes 1–2 minutes' : 'Abstracts render here in template order'} />
                {selected && !byTenant.get(selected.toLowerCase()) && (
                  <div style={{ textAlign: 'center', marginTop: 10 }}>
                    <button onClick={() => void generate(selected)} disabled={generating.has(selected)}
                      style={{ fontSize: 12, fontWeight: 600, padding: '7px 16px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer' }}>
                      {generating.has(selected) ? 'Generating (1–2 min)…' : `Generate abstract for ${selected}`}
                    </button>
                  </div>
                )}
              </Widget>
            )}
            {selectedAbstract && <AbstractView row={selectedAbstract}
              onRegenerate={() => void generate(selectedAbstract.tenant_name)} busy={generating.has(selectedAbstract.tenant_name)}
              onVerify={() => void verify(selectedAbstract.tenant_name)} verifying={verifying.has(selectedAbstract.tenant_name)}
              onSaved={() => setBump(b => b + 1)} reviewerId={appUser?.id} />}
          </div>
        </div>
      ) : (
        <Widget title={`Clause matrix — ${CLAUSES.find(c => c.key === clause)?.label}`} chip={`${(abstracts.data ?? []).length} abstracts`} fullWidth>
          {(abstracts.data ?? []).length === 0
            ? <EmptyState title="No abstracts yet" subtitle="Generate abstracts in the By-tenant view first — the matrix compares them" />
            : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead><tr style={{ textAlign: 'left', color: 'var(--text-faint)', fontSize: 11 }}>
                  <th style={{ padding: '4px 8px', width: 220 }}>Tenant</th><th style={{ padding: '4px 8px' }}>{CLAUSES.find(c => c.key === clause)?.label}</th>
                </tr></thead>
                <tbody>
                  {(abstracts.data ?? []).slice().sort((a, b) => a.tenant_name.localeCompare(b.tenant_name)).map(a => (
                    <tr key={a.id} style={{ borderTop: '1px solid var(--border)', verticalAlign: 'top' }}>
                      <td style={{ padding: '6px 8px', color: 'var(--text)', fontWeight: 600 }}>{a.tenant_name}</td>
                      <td style={{ padding: '6px 8px', color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>
                        {CLAUSES.find(c => c.key === clause)?.render(a.abstract) || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </Widget>
      )}
    </div>
  )
}

// Sequentially generates every tenant that has no abstract yet. Keep the tab
// open while it runs (~1-2 min per tenant).
function GenerateAllButton({ tenants, byTenant, generating, onGenerate }: {
  tenants: string[]
  byTenant: Map<string, AbstractRow>
  generating: Set<string>
  onGenerate: (t: string) => Promise<void>
}) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const missing = tenants.filter(t => !byTenant.has(t.toLowerCase()))

  async function run() {
    if (running || !missing.length) return
    setRunning(true)
    let done = 0
    for (const t of missing) {
      setProgress(`${done + 1}/${missing.length}: ${t}`)
      await onGenerate(t)          // errors surface via the page banner; keep going
      done++
    }
    setProgress('')
    setRunning(false)
  }

  if (!missing.length) return <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>All tenants abstracted ✓</span>
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button onClick={() => void run()} disabled={running || generating.size > 0}
        style={{
          fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: 'none',
          background: running ? 'var(--surface-2)' : 'var(--accent)',
          color: running ? 'var(--text-muted)' : '#fff', cursor: running ? 'default' : 'pointer',
        }}>
        {running ? 'Generating…' : `Generate all missing (${missing.length})`}
      </button>
      {running && <span style={{ fontSize: 11, color: 'var(--amber)' }}>{progress} — keep this tab open</span>}
    </span>
  )
}

// Sequentially verifies every abstract that has not been verified since its
// last generation. Surfaces batch problems (e.g. stale post-amendment terms
// across a whole property) in one pass. Keep the tab open (~1-2 min each).
function VerifyAllButton({ abstracts, verifying, onVerify }: {
  abstracts: AbstractRow[]
  verifying: Set<string>
  onVerify: (t: string) => Promise<void>
}) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const unverified = abstracts.filter(a => !a.qa_status)

  async function run() {
    if (running || !unverified.length) return
    setRunning(true)
    let done = 0
    for (const a of unverified) {
      setProgress(`${done + 1}/${unverified.length}: ${a.tenant_name}`)
      await onVerify(a.tenant_name)      // errors surface via the page banner; keep going
      done++
    }
    setProgress('')
    setRunning(false)
  }

  if (!abstracts.length) return null
  if (!unverified.length) return <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>All verified ✓</span>
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button onClick={() => void run()} disabled={running || verifying.size > 0}
        style={{
          fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6,
          border: `1px solid ${running ? 'var(--border-2)' : 'var(--accent)'}`,
          background: running ? 'var(--surface-2)' : 'var(--accent-dim)',
          color: running ? 'var(--text-muted)' : 'var(--accent)', cursor: running ? 'default' : 'pointer',
        }}>
        {running ? 'Verifying…' : `Verify all (${unverified.length})`}
      </button>
      {running && <span style={{ fontSize: 11, color: 'var(--amber)' }}>{progress} — keep this tab open</span>}
    </span>
  )
}

// LIVING ABSTRACTS: unseen refresh-log entries — abstracts the nightly watcher
// regenerated (with field diffs) because a new document arrived, or locked
// abstracts flagged for manual review. Dismiss marks seen.
function RefreshLogBanner({ onJump }: { onJump: (tenant: string) => void }) {
  const [bump, setBump] = useState(0)
  const events = useQuery<any[]>(async () => {
    const { data, error } = await supabase.from('abstract_refresh_log')
      .select('id, tenant_name, doc_title, action, qa_status, changes, material, created_at')
      .eq('seen', false).order('created_at', { ascending: false }).limit(20)
    if (error) throw new Error(error.message)
    return data ?? []
  }, [bump])
  async function dismiss(id: string) {
    await supabase.from('abstract_refresh_log').update({ seen: true }).eq('id', id)
    setBump(b => b + 1)
  }
  if (!events.data?.length) return null
  return (
    <div style={{ border: '1px solid var(--accent)', background: 'var(--accent-dim)', borderRadius: 8, padding: '10px 14px', marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent)', marginBottom: 6 }}>
        ⟳ Abstract changes from newly-ingested documents ({events.data.length})
      </div>
      {events.data.map(e => (
        <div key={e.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '4px 0', borderTop: '1px solid var(--border)', flexWrap: 'wrap' }}>
          <button onClick={() => onJump(e.tenant_name)}
            style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            {e.tenant_name}
          </button>
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)', flex: 1, minWidth: 200 }}>
            {e.action === 'locked_needs_review'
              ? <>🔒 locked — new document needs manual review: <em>{e.doc_title}</em></>
              : e.action === 'regen_failed'
                ? <>regeneration failed — retry from the tenant list</>
                : e.changes && Object.keys(e.changes).length
                  ? <>auto-regenerated ({e.qa_status ?? '—'}): {Object.entries(e.changes as Record<string, any>).map(([k, v]) => `${k}: ${v.old || '—'} → ${v.new || '—'}`).join(' · ')}</>
                  : <>auto-regenerated ({e.qa_status ?? '—'}) — no high-value field changed</>}
          </span>
          <button onClick={() => void dismiss(e.id)}
            style={{ fontSize: 10, padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer' }}>
            Dismiss
          </button>
        </div>
      ))}
    </div>
  )
}

// Portfolio-wide AI accuracy, measured against human ground truth: every locked
// abstract = 7 reviewed fields; `overrides` records exactly which the reviewer
// had to correct (v_abstract_accuracy, migration 20240061). The number that makes
// the abstractor's quality provable — recomputes live as the team locks reviews.
function AccuracyChip() {
  const acc = useQuery<{ locked_abstracts: number; fields_reviewed: number; fields_corrected: number; field_accuracy_pct: number | null }>(async () => {
    const { data, error } = await supabase.from('v_abstract_accuracy').select('*').single()
    if (error) throw new Error(error.message)
    return data as any
  }, [])
  if (!acc.data) return null
  if (!acc.data.locked_abstracts) {
    return <span style={{ fontSize: 11, color: 'var(--text-faint)' }} title="Lock human-verified abstracts (Review & correct) to start measuring AI accuracy">accuracy: unmeasured — lock reviews to begin</span>
  }
  return (
    <span title={`${acc.data.fields_corrected} of ${acc.data.fields_reviewed} human-reviewed fields needed correction, across ${acc.data.locked_abstracts} locked abstracts`}
      style={{ fontSize: 11, fontWeight: 700, padding: '2px 10px', borderRadius: 10, color: 'var(--green, #22c55e)', background: 'rgba(34,197,94,0.12)' }}>
      AI accuracy {acc.data.field_accuracy_pct}% · {acc.data.locked_abstracts} verified
    </span>
  )
}

function ModeButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: '5px 12px', borderRadius: 20, fontSize: 12, cursor: 'pointer', fontWeight: active ? 600 : 400,
      border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
      background: active ? 'var(--accent-dim)' : 'transparent',
      color: active ? 'var(--accent)' : 'var(--text-muted)',
    }}>{label}</button>
  )
}

const fmtMoney = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

// Exported: the /diligence DD workspace renders the same abstract view.
export function AbstractView({ row, onRegenerate, busy, onVerify, verifying, onSaved, reviewerId }: {
  row: AbstractRow; onRegenerate: () => void; busy: boolean; onVerify: () => void; verifying: boolean
  onSaved: () => void; reviewerId?: string
}) {
  // Display/export the human-corrected values layered over the AI abstract.
  const a = applyOverrides(row.abstract, row.overrides) ?? {}
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
          {row.human_verified && <span style={{ color: 'var(--green, #22c55e)', fontWeight: 700 }}>🔒 Human-verified · </span>}
          Generated {new Date(row.generated_at).toLocaleString()} · {row.source_doc_ids?.length ?? 0} source documents{row.human_verified ? '' : ' · verify against the source lease before relying on it'}
        </span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={onVerify} disabled={verifying || busy}
            style={{ fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 6, border: '1px solid var(--accent)', background: 'var(--accent-dim)', color: 'var(--accent)', cursor: verifying || busy ? 'default' : 'pointer' }}>
            {verifying ? 'Verifying (1–2 min)…' : row.qa_status ? 'Re-verify' : 'Verify against source'}
          </button>
          <button onClick={onRegenerate} disabled={busy || row.locked}
            title={row.locked ? 'Locked — unlock in Review & correct to regenerate' : undefined}
            style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: row.locked ? 'not-allowed' : 'pointer', opacity: row.locked ? 0.5 : 1 }}>
            {busy ? 'Regenerating…' : row.locked ? '🔒 Regenerate' : 'Regenerate'}
          </button>
        </div>
      </div>

      <ReviewPanel row={row} onSaved={onSaved} reviewerId={reviewerId} />

      {row.qa && <QaPanel qa={row.qa} status={row.qa_status} at={row.qa_at} sourceDocIds={row.source_doc_ids ?? []} />}

      <Widget title={`${a.trade_name ?? row.tenant_name} — Lease Abstract`} chip={a.suite ? `Suite ${a.suite}` : undefined}>
        <Grid>
          <Fact k="Trade name (dba)" v={a.trade_name} />
          <Fact k="Tenant legal name" v={a.tenant_legal_name} />
          <Fact k="Suite" v={a.suite} />
          <Fact k="Square footage" v={a.square_footage?.toLocaleString?.() ?? a.square_footage} />
          <Fact k="Rent commencement" v={a.term?.rent_commencement} />
          <Fact k="Expiration" v={a.term?.expiration} />
          <Fact k="Term (yrs)" v={a.term?.term_years} />
          <Fact k="Guarantor" v={a.guarantor?.exists ? `${a.guarantor.name ?? 'Yes'}${a.guarantor.section ? ` [${a.guarantor.section}]` : ''}` : 'None'} />
        </Grid>
      </Widget>

      <Widget title="Lease documents" chip={`${(a.lease_documents ?? []).length} instruments`}>
        {(a.lease_documents ?? []).length === 0
          ? <MissingNote what="No instruments catalogued" />
          : <MiniTable head={['Type', 'Date', 'Signed', 'Notes']}
              rows={a.lease_documents.map((d: any) => [d.type, d.date, d.signed, d.notes])} />}
      </Widget>

      <Widget title="Base / minimum rent">
        {(a.base_rent_schedule ?? []).length === 0
          ? <MissingNote what="No rent schedule found in the reviewed documents" />
          : <MiniTable head={['Start', 'End', '$ PSF', 'Monthly', 'Annual']}
              rows={a.base_rent_schedule.map((r: any) => [r.start, r.end, r.psf, fmtMoney(r.monthly), fmtMoney(r.annual)])} />}
      </Widget>

      <Widget title="Options" chip={(a.options ?? [])[0]?.section}>
        {(a.options ?? []).length === 0
          ? <MissingNote what="No renewal/extension options found" />
          : <MiniTable head={['Term', 'Notice', 'Start', 'End', '$ PSF', 'Annual', 'Section']}
              rows={a.options.map((o: any) => [o.term, o.notice_period, o.start, o.end, o.psf, fmtMoney(o.annual), o.section])} />}
      </Widget>

      <Widget title="Percentage rent & sales reporting">
        <Grid>
          <Fact k="Percentage rent" v={a.percentage_rent?.applicable ? `${a.percentage_rent.rate_pct ?? '?'}% over ${a.percentage_rent.breakpoint ?? '?'}` : 'None'} />
          <Fact k="Section" v={a.percentage_rent?.section} />
          <Fact k="Sales reporting" v={a.sales_reporting?.reports ? a.sales_reporting.frequency : 'Does not report'} />
          <Fact k="Notes" v={a.percentage_rent?.notes} wide />
        </Grid>
      </Widget>

      <Widget title="Reimbursements — CAM / RET / Insurance" chip={a.cam?.section}>
        <LongFact k="CAM methodology" v={a.cam?.methodology} />
        <LongFact k="CAM exact language" v={a.cam?.details_exact_language} />
        <LongFact k="Pro-rata share calc / denominator" v={a.cam?.prorata_share_calc} />
        <LongFact k="Definition of shopping center" v={a.cam?.shopping_center_definition} />
        <LongFact k="Admin fee" v={a.cam?.admin_fee} />
        <LongFact k="Caps / exclusions" v={a.cam?.caps_exclusions} />
        <LongFact k="Audit rights" v={a.cam?.audit_rights ? `Yes${a.cam?.audit_years_back ? ` — ${a.cam.audit_years_back}` : ''}` : a.cam?.audit_rights === false ? 'No' : null} />
        <LongFact k={`Real estate tax methodology ${a.real_estate_tax?.section ? `[${a.real_estate_tax.section}]` : ''}`} v={a.real_estate_tax?.methodology} />
        <LongFact k="RET caps on sale/reassessment" v={a.real_estate_tax?.sale_reassessment_caps} />
        <LongFact k={`Insurance methodology ${a.insurance?.section ? `[${a.insurance.section}]` : ''}`} v={a.insurance?.methodology} />
      </Widget>

      <Widget title="Key clauses">
        <LongFact k={`Co-tenancy ${a.co_tenancy?.section ? `[${a.co_tenancy.section}]` : ''}`} v={a.co_tenancy?.exists ? a.co_tenancy.exact_language_and_remedies : 'None'} />
        <LongFact k="Replacement tenants" v={a.co_tenancy?.replacement_tenants_permitted} />
        <LongFact k={`Exclusives ${a.exclusives?.section ? `[${a.exclusives.section}]` : ''}`} v={a.exclusives?.exists ? a.exclusives.exact_language : 'None'} />
        <LongFact k={`Termination / kickout ${a.termination_kickout?.section ? `[${a.termination_kickout.section}]` : ''}`} v={a.termination_kickout?.exists ? a.termination_kickout.details : 'None'} />
        <LongFact k={`Permitted use ${a.permitted_use?.section ? `[${a.permitted_use.section}]` : ''}`} v={a.permitted_use?.exact_language} />
        <LongFact k={`Prohibited uses ${a.prohibited_uses?.section ? `[${a.prohibited_uses.section}]` : ''}`} v={a.prohibited_uses?.exact_language} />
        <LongFact k="Radius clause" v={a.radius_clause?.exists ? a.radius_clause.details : 'None'} />
        <LongFact k="Continuous operations" v={a.continuous_operations?.exists ? a.continuous_operations.details : 'None'} />
        <LongFact k="Relocation rights" v={a.relocation_rights?.exists ? `${a.relocation_rights.who_pays ?? ''} ${a.relocation_rights.notes ?? ''}` : 'None'} />
        <LongFact k="Recapture rights" v={a.recapture_rights?.exists ? a.recapture_rights.details : 'None'} />
        <LongFact k="Assignment & subletting" v={[a.assignment_subletting?.allowed, a.assignment_subletting?.liability_continues_post_assignment, a.assignment_subletting?.notes].filter(Boolean).join(' · ')} />
        <LongFact k="Option to purchase" v={a.option_to_purchase?.exists ? a.option_to_purchase.details : 'None'} />
      </Widget>

      <Widget title="Deposits, allowances, signage & delivery">
        <Grid>
          <Fact k="Security deposit" v={a.security_deposit?.exists ? `${a.security_deposit.type ?? ''} ${fmtMoney(a.security_deposit.total)}` : 'None'} />
          <Fact k="Tenant allowance" v={a.tenant_allowance?.exists ? `${fmtMoney(a.tenant_allowance.total)}${a.tenant_allowance.psf ? ` ($${a.tenant_allowance.psf}/SF)` : ''}` : 'None'} />
          <Fact k="Parking" v={a.parking?.spaces_per_1000 ? `${a.parking.spaces_per_1000}/1000 SF` : a.parking?.notes} />
          <Fact k="Signage — pylon/monument" v={a.signage?.pylon_monument_right == null ? a.signage?.notes : a.signage.pylon_monument_right ? `Yes ${a.signage?.notes ?? ''}` : 'No'} />
          <Fact k="Estoppel delivery" v={a.estoppel?.timing_for_delivery} />
          <Fact k="SNDA delivery" v={a.snda?.timing_for_delivery} />
        </Grid>
        {a.additional_rights_notes && <LongFact k="More / notes" v={a.additional_rights_notes} />}
      </Widget>

      {(a.open_items ?? []).length > 0 && (
        <Widget title="Open items / missing documents" chip={`${a.open_items.length}`}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {a.open_items.map((x: string, i: number) => (
              <li key={i} style={{ fontSize: 12, color: 'var(--amber)', marginBottom: 4 }}>{x}</li>
            ))}
          </ul>
        </Widget>
      )}
    </div>
  )
}

// Compact QA status pill for the tenant list. No verdict yet = a muted "verify"
// hint so untested abstracts read as unverified, not implicitly trusted.
const QA_META: Record<string, { label: string; color: string; bg: string }> = {
  verified: { label: '✓ verified', color: 'var(--green, #22c55e)', bg: 'rgba(34,197,94,0.12)' },
  issues:   { label: '⚠ issues',   color: 'var(--red, #ef4444)',   bg: 'rgba(239,68,68,0.12)' },
  review:   { label: '● review',   color: 'var(--amber)',           bg: 'rgba(245,158,11,0.12)' },
}
function QaBadge({ status }: { status: string | null }) {
  const m = status ? QA_META[status] : null
  if (!m) return <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>unverified</span>
  return <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 10, color: m.color, background: m.bg, whiteSpace: 'nowrap' }}>{m.label}</span>
}

const VERDICT_META: Record<string, { color: string; label: string }> = {
  confirmed:    { color: 'var(--green, #22c55e)', label: 'Confirmed' },
  discrepancy:  { color: 'var(--red, #ef4444)',   label: 'Discrepancy' },
  unsupported:  { color: 'var(--red, #ef4444)',   label: 'Unsupported' },
  needs_source: { color: 'var(--amber)',           label: 'Needs source' },
}

// Renders the verification verdict: headline status + confidence, then the
// checks that FAILED first (discrepancies/unsupported/needs-source), arithmetic
// + amendment-currency, fabrication risk, and recommended fixes. Confirmed
// checks collapse behind a toggle so the eye lands on what needs a human.
// Click-to-source: locate a verifier's verbatim quote inside the abstract's
// source documents (text chunks carry page_number) and open the actual PDF at
// that page (browsers honor #page=N on inline PDFs). Field-level trust: see the
// clause, not just a citation string.
async function openQuoteSource(quote: string, sourceDocIds: string[]): Promise<boolean> {
  if (!quote || !sourceDocIds.length) return false
  const words = quote.replace(/[%_]/g, ' ').replace(/\s+/g, ' ').trim().split(' ')
  for (const n of [8, 4]) {                      // distinctive first, looser fallback
    if (words.length < Math.min(n, 3)) continue
    const pat = '%' + words.slice(0, n).join('%') + '%'
    const { data } = await supabase.from('document_chunks')
      .select('document_id, page_number')
      .in('document_id', sourceDocIds)
      .eq('kind', 'text')
      .ilike('content', pat)
      .limit(1)
    const hit = data?.[0]
    if (hit) {
      const { data: doc } = await supabase.from('documents')
        .select('storage_path').eq('id', hit.document_id).single()
      if (!doc?.storage_path) return false
      const { data: signed } = await supabase.storage.from('documents')
        .createSignedUrl(doc.storage_path, 3600)
      if (!signed?.signedUrl) return false
      window.open(signed.signedUrl + (hit.page_number ? `#page=${hit.page_number}` : ''), '_blank')
      return true
    }
  }
  return false
}

function SourceLink({ quote, sourceDocIds }: { quote: string; sourceDocIds: string[] }) {
  const [state, setState] = useState<'idle' | 'busy' | 'miss'>('idle')
  if (!quote || !sourceDocIds.length) return null
  return (
    <button
      onClick={async () => {
        setState('busy')
        const ok = await openQuoteSource(quote, sourceDocIds).catch(() => false)
        setState(ok ? 'idle' : 'miss')
      }}
      disabled={state === 'busy'}
      title={state === 'miss' ? 'Quote not located in indexed text (scanned page wording may differ)' : 'Open the source PDF at the cited page'}
      style={{ fontSize: 10, fontWeight: 600, padding: '1px 8px', marginLeft: 6, borderRadius: 9, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: state === 'miss' ? 'var(--text-faint)' : 'var(--accent)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
      {state === 'busy' ? 'locating…' : state === 'miss' ? 'not located' : 'view source ↗'}
    </button>
  )
}

function QaPanel({ qa, status, at, sourceDocIds }: { qa: any; status: string | null; at: string | null; sourceDocIds: string[] }) {
  const [showConfirmed, setShowConfirmed] = useState(false)
  // Collapsed by default so the abstract reads clean; auto-open only when the
  // verdict is "issues" (a real problem a human must see). The summary + any
  // stale-amendment warning stay visible even when collapsed.
  const [open, setOpen] = useState(status === 'issues')
  const meta = status ? QA_META[status] : null
  const checks: any[] = Array.isArray(qa?.field_checks) ? qa.field_checks : []
  const flagged = checks.filter(c => c?.verdict && c.verdict !== 'confirmed')
  const confirmed = checks.filter(c => c?.verdict === 'confirmed')
  const arith: any[] = Array.isArray(qa?.arithmetic) ? qa.arithmetic : []
  const arithFails = arith.filter(a => a?.ok === false)
  const fixes: string[] = Array.isArray(qa?.recommended_fixes) ? qa.recommended_fixes : []
  const stale = qa?.amendment_currency?.current === false
  // MRI reconciliation is a data-conflict signal, NOT an abstract defect. New
  // verdicts carry a structured `mri_reconciliation` array; older ones fold MRI
  // conflicts into field_checks notes — split those out so they don't read as
  // document errors. Document-only flags stay in "Flagged".
  const mriRe = /\bMRI\b|system[- ]of[- ]record/i
  const mriRecon: any[] = Array.isArray(qa?.mri_reconciliation) ? qa.mri_reconciliation : []
  const flaggedMri = mriRecon.length ? [] : flagged.filter(c => mriRe.test(c?.note || ''))
  const flaggedDoc = mriRecon.length ? flagged : flagged.filter(c => !mriRe.test(c?.note || ''))
  const hasMri = mriRecon.length > 0 || flaggedMri.length > 0

  const Check = ({ c }: { c: any }) => {
    const vm = VERDICT_META[c.verdict] ?? { color: 'var(--text-muted)', label: c.verdict }
    return (
      <div style={{ padding: '7px 0', borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: vm.color, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{vm.label}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{c.field}</span>
          {c.severity && c.verdict !== 'confirmed' && <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>({c.severity})</span>}
        </div>
        {c.note && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>{c.note}</div>}
        {c.abstract_value != null && c.abstract_value !== '' && (
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>Abstract: <span style={{ color: 'var(--text-muted)' }}>{String(c.abstract_value)}</span></div>
        )}
        {c.source_quote && (
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3, paddingLeft: 8, borderLeft: '2px solid var(--border-2)', fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>
            “{c.source_quote}”{c.citation ? <span style={{ fontStyle: 'normal', color: 'var(--text-faint)' }}> — {c.citation}</span> : null}
            <SourceLink quote={c.source_quote} sourceDocIds={sourceDocIds} />
          </div>
        )}
      </div>
    )
  }

  return (
    <Widget title="Verification"
      chip={meta ? meta.label : qa?.confidence ? `${qa.confidence} confidence` : undefined}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 6 }}>
        {meta && <span style={{ fontSize: 11, fontWeight: 700, color: meta.color, padding: '1px 8px', borderRadius: 10, background: meta.bg }}>{meta.label}</span>}
        {qa?.confidence && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{qa.confidence} confidence</span>}
        {hasMri && <span style={{ fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 10, color: 'var(--accent)', background: 'var(--accent-dim)' }}>MRI conflict</span>}
        {at && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>· checked {new Date(at).toLocaleString()}</span>}
        {(flaggedDoc.length + arithFails.length + fixes.length + (mriRecon.length || flaggedMri.length)) > 0 && (
          <button onClick={() => setOpen(o => !o)}
            style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            {open ? 'Hide details ▾' : `Show details ▸ (${flaggedDoc.length + arithFails.length + fixes.length + (mriRecon.length || flaggedMri.length)})`}
          </button>
        )}
      </div>
      {qa?.summary && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 8 }}>{qa.summary}</div>}

      {stale && (
        <div style={{ fontSize: 12, color: 'var(--red, #ef4444)', fontWeight: 600, marginBottom: 6 }}>
          ⚠ Latest-amendment terms may NOT be reflected{qa?.amendment_currency?.note ? ` — ${qa.amendment_currency.note}` : ''}
        </div>
      )}

      {open && (<>

      {flaggedDoc.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Flagged vs. documents ({flaggedDoc.length})</div>
          {flaggedDoc.map((c, i) => <Check key={i} c={c} />)}
        </div>
      )}

      {hasMri && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
            MRI reconciliation ({mriRecon.length || flaggedMri.length})
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 3 }}>Abstract disagrees with the MRI system-of-record — a data conflict to reconcile, not necessarily an abstract error.</div>
          {mriRecon.length > 0
            ? mriRecon.map((m, i) => (
                <div key={i} style={{ padding: '6px 0', borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                    {m.field} {m.governs && <span style={{ fontSize: 10, fontWeight: 700, color: m.governs === 'mri' ? 'var(--red, #ef4444)' : 'var(--text-faint)' }}>· {m.governs === 'abstract' ? 'documents govern' : m.governs === 'mri' ? 'MRI likely correct — abstract wrong' : 'unclear'}</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>Abstract: {String(m.abstract_value ?? '—')} · MRI: {String(m.mri_value ?? '—')}</div>
                  {m.note && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>{m.note}</div>}
                </div>
              ))
            : flaggedMri.map((c, i) => <Check key={i} c={c} />)}
        </div>
      )}

      {arithFails.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--red, #ef4444)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Arithmetic checks failed</div>
          {arithFails.map((x, i) => <div key={i} style={{ fontSize: 12, color: 'var(--text-muted)', padding: '3px 0' }}>✗ {x.check}{x.detail ? ` — ${x.detail}` : ''}</div>)}
        </div>
      )}

      {fixes.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Recommended fixes</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {fixes.map((x, i) => <li key={i} style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 2 }}>{x}</li>)}
          </ul>
        </div>
      )}

      {confirmed.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button onClick={() => setShowConfirmed(s => !s)}
            style={{ fontSize: 11, color: 'var(--text-faint)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
            {showConfirmed ? '▾' : '▸'} {confirmed.length} confirmed {confirmed.length === 1 ? 'field' : 'fields'}
          </button>
          {showConfirmed && confirmed.map((c, i) => <Check key={i} c={c} />)}
        </div>
      )}

      </>)}
    </Widget>
  )
}

// Reviewer corrections are stored as a dotted-path → value map and layered over
// the AI abstract for display/export; the AI JSON itself is never mutated.
const getPath = (o: any, path: string) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o)
function applyOverrides(abstract: any, overrides: Record<string, any> | null | undefined) {
  if (!overrides || !Object.keys(overrides).length) return abstract
  const clone = JSON.parse(JSON.stringify(abstract ?? {}))
  for (const [path, val] of Object.entries(overrides)) {
    const parts = path.split('.')
    let o = clone
    for (let i = 0; i < parts.length - 1; i++) {
      if (o[parts[i]] == null || typeof o[parts[i]] !== 'object') o[parts[i]] = {}
      o = o[parts[i]]
    }
    o[parts[parts.length - 1]] = val
  }
  return clone
}

// High-value scalar fields a reviewer most often corrects (the ones QA flags:
// names, suite, SF, the term dates). Deliberately not a full nested-JSON editor.
const REVIEW_FIELDS: Array<{ path: string; label: string; num?: boolean }> = [
  { path: 'trade_name', label: 'Trade name (dba)' },
  { path: 'tenant_legal_name', label: 'Tenant legal name' },
  { path: 'suite', label: 'Suite' },
  { path: 'square_footage', label: 'Square footage', num: true },
  { path: 'term.rent_commencement', label: 'Rent commencement' },
  { path: 'term.expiration', label: 'Expiration' },
  { path: 'term.term_years', label: 'Term (years)', num: true },
]

function ReviewPanel({ row, onSaved, reviewerId }: { row: AbstractRow; onSaved: () => void; reviewerId?: string }) {
  const effective = applyOverrides(row.abstract, row.overrides) ?? {}
  const [edits, setEdits] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const f of REVIEW_FIELDS) { const v = getPath(effective, f.path); init[f.path] = v == null ? '' : String(v) }
    return init
  })
  const [note, setNote] = useState(row.review_note ?? '')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  async function save(opts: { lock?: boolean; verified?: boolean }) {
    setSaving(true); setErr(null)
    try {
      // Store an override only where the reviewer's value differs from the AI value.
      const overrides: Record<string, any> = {}
      for (const f of REVIEW_FIELDS) {
        const raw = (edits[f.path] ?? '').trim()
        if (raw === '') continue
        const val = f.num ? Number(raw) : raw
        if (f.num && Number.isNaN(val as number)) continue
        const aiVal = getPath(row.abstract, f.path)
        if (String(aiVal ?? '') !== String(val)) overrides[f.path] = val
      }
      const patch: any = {
        overrides: Object.keys(overrides).length ? overrides : null,
        review_note: note.trim() || null,
        reviewed_by: reviewerId ?? null,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      if (opts.verified !== undefined) patch.human_verified = opts.verified
      if (opts.lock !== undefined) patch.locked = opts.lock
      const { error } = await supabase.from('lease_abstracts').update(patch).eq('id', row.id)
      if (error) throw new Error(error.message)
      onSaved()
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setSaving(false) }
  }

  const overrideCount = row.overrides ? Object.keys(row.overrides).length : 0
  return (
    <Widget title="Review & correct"
      chip={row.human_verified ? 'human-verified' : overrideCount ? `${overrideCount} correction${overrideCount === 1 ? '' : 's'}` : undefined}>
      {!open ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {row.human_verified
              ? `Verified${row.reviewed_at ? ` ${new Date(row.reviewed_at).toLocaleDateString()}` : ''}${row.locked ? ' · locked' : ''}.`
              : 'Correct any field and mark the abstract human-verified.'}
          </span>
          <button onClick={() => setOpen(true)}
            style={{ fontSize: 11, fontWeight: 600, padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer' }}>
            {overrideCount || row.human_verified ? 'Edit review' : 'Review & correct'}
          </button>
          {row.locked && (
            <button onClick={() => void save({ lock: false })} disabled={saving}
              style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
              {saving ? '…' : 'Unlock'}
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Blank = keep the AI value. A value that differs from the AI abstract is saved as a correction and shown in green throughout.</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '8px 14px' }}>
            {REVIEW_FIELDS.map(f => {
              const aiVal = getPath(row.abstract, f.path)
              const changed = (edits[f.path] ?? '').trim() !== '' && String(aiVal ?? '') !== (edits[f.path] ?? '').trim()
              return (
                <div key={f.path}>
                  <div style={{ fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{f.label}</div>
                  <input value={edits[f.path] ?? ''} onChange={e => setEdits(s => ({ ...s, [f.path]: e.target.value }))}
                    placeholder={aiVal == null ? '—' : String(aiVal)}
                    style={{ width: '100%', fontSize: 12, padding: '5px 8px', borderRadius: 5, background: 'var(--surface-2)', color: 'var(--text)', border: `1px solid ${changed ? 'var(--green, #22c55e)' : 'var(--border-2)'}` }} />
                  {changed && <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 1 }}>AI: {aiVal == null ? '—' : String(aiVal)}</div>}
                </div>
              )
            })}
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Reviewer note</div>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={2}
              style={{ width: '100%', fontSize: 12, padding: '6px 8px', borderRadius: 5, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)', resize: 'vertical' }} />
          </div>
          {err && <div style={{ fontSize: 12, color: 'var(--red)' }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => void save({})} disabled={saving}
              style={{ fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: 'none', background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer' }}>
              {saving ? 'Saving…' : 'Save corrections'}
            </button>
            <button onClick={() => void save({ verified: true, lock: true })} disabled={saving}
              style={{ fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: 'none', background: 'var(--green, #22c55e)', color: '#fff', cursor: 'pointer' }}>
              {saving ? '…' : 'Mark verified & lock'}
            </button>
            <button onClick={() => { setOpen(false); setErr(null) }} disabled={saving}
              style={{ fontSize: 12, padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </Widget>
  )
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px 16px' }}>{children}</div>
}
function Fact({ k, v, wide }: { k: string; v: any; wide?: boolean }) {
  return (
    <div style={{ gridColumn: wide ? '1 / -1' : undefined }}>
      <div style={{ fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{k}</div>
      <div style={{ fontSize: 13, color: 'var(--text)' }}>{v == null || v === '' ? '—' : String(v)}</div>
    </div>
  )
}
// Every template field renders — an empty field says so explicitly rather than
// disappearing (gaps also land in the Open Items section).
function LongFact({ k, v }: { k: string; v: any }) {
  const missing = v == null || v === ''
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{k}</div>
      <div style={{ fontSize: 12.5, color: missing ? 'var(--text-faint)' : 'var(--text-muted)', lineHeight: 1.5, whiteSpace: 'pre-wrap', fontStyle: missing ? 'italic' : 'normal' }}>
        {missing ? 'Not found in reviewed documents — see Open items' : String(v)}
      </div>
    </div>
  )
}

function MissingNote({ what }: { what: string }) {
  return <div style={{ fontSize: 12, color: 'var(--text-faint)', fontStyle: 'italic' }}>{what} — see Open items</div>
}
function MiniTable({ head, rows }: { head: string[]; rows: any[][] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead><tr style={{ textAlign: 'left', color: 'var(--text-faint)', fontSize: 10.5 }}>
        {head.map(h => <th key={h} style={{ padding: '3px 8px', fontWeight: 600 }}>{h}</th>)}
      </tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
            {r.map((c, j) => <td key={j} style={{ padding: '5px 8px', color: 'var(--text)', verticalAlign: 'top' }}>{c == null || c === '' ? '—' : String(c)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
