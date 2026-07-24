import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

// ── MRI Imports (audit Phase 2: staged import) ───────────────────────────────
// Monthly MRI drops staged by the loader (RR_STAGE=1) land here as batches with
// a computed diff vs the property's latest snapshot. A human reviews the diff
// (new / changed / departed tenants) and Approves — apply_mri_import replaces
// the period atomically — or Rejects with a note. Nothing touches live
// rent-roll data until that click.

interface Batch {
  id: string
  kind: string
  property_id: string
  period_year: number
  period_month: number
  label: string | null
  source_file: string | null
  status: string
  summary: any
  diff: any
  created_at: string
  decided_at: string | null
  decision_note: string | null
  applied_at: string | null
}

const STATUS_COLOR: Record<string, string> = {
  staged: 'var(--amber, #f59e0b)',
  approved: 'var(--accent)',
  applied: 'var(--green, #22c55e)',
  rejected: 'var(--text-muted)',
}
const fmt$ = (n: unknown) => (n == null || n === '' ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }))
const fmtN = (n: unknown) => (n == null || n === '' ? '—' : Number(n).toLocaleString('en-US'))
const KIND_LABEL: Record<string, string> = { rentroll: 'rent roll', gl: 'general ledger' }

export function ImportsPage() {
  const [batches, setBatches] = useState<Batch[]>([])
  const [propNames, setPropNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selId, setSelId] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [actErr, setActErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const { data, error: e } = await supabase.from('mri_import_batches')
        .select('*').order('created_at', { ascending: false }).limit(100)
      if (e) throw new Error(e.message)
      setBatches((data ?? []) as Batch[])
      const pids = [...new Set(((data ?? []) as Batch[]).map(b => b.property_id))]
      if (pids.length) {
        const { data: props } = await supabase.from('properties').select('id, name').in('id', pids)
        setPropNames(Object.fromEntries(((props ?? []) as any[]).map(p => [p.id, p.name])))
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const sel = useMemo(() => batches.find(b => b.id === selId) ?? null, [batches, selId])
  const diff = sel?.diff ?? null

  async function approve() {
    if (!sel) return
    setBusy(true); setActErr(null)
    try {
      const { data, error: e } = await supabase.rpc('apply_mri_import', { p_batch: sel.id, p_note: note.trim() || null })
      if (e) throw new Error(e.message)
      setNote('')
      await load()
      setSelId(sel.id)
      void data
    } catch (e) {
      setActErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function reject() {
    if (!sel) return
    setBusy(true); setActErr(null)
    try {
      const { data: auth } = await supabase.auth.getUser()
      const { error: e } = await supabase.from('mri_import_batches')
        .update({ status: 'rejected', decided_by: auth?.user?.id ?? null, decided_at: new Date().toISOString(), decision_note: note.trim() || null })
        .eq('id', sel.id)
      if (e) throw new Error(e.message)
      setNote('')
      await load()
      setSelId(sel.id)
    } catch (e) {
      setActErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
      {/* batches list */}
      <div style={{ width: 350, minWidth: 300 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>MRI import batches</h2>
          <button onClick={() => void load()} style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px', borderRadius: 5, border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}>↻</button>
        </div>
        {loading && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>}
        {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
        {!loading && !batches.length && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            No staged imports. Run the rent-roll loader with <code>RR_STAGE=1</code> or the GL
            loader with <code>GL_STAGE=1</code> to stage a monthly MRI drop for review here
            (instead of writing it straight to the database).
          </div>
        )}
        {batches.map(b => (
          <div key={b.id} onClick={() => { setSelId(b.id); setActErr(null) }}
            style={{ padding: '10px 12px', borderRadius: 8, border: `1px solid ${selId === b.id ? 'var(--accent)' : 'var(--border-2)'}`, marginBottom: 8, cursor: 'pointer', background: 'var(--surface-1, transparent)' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <span style={{ fontSize: 13, fontWeight: 700 }}>{b.label ?? propNames[b.property_id] ?? b.kind}</span>
              <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 700, color: STATUS_COLOR[b.status] ?? 'var(--text-muted)', textTransform: 'uppercase' }}>{b.status}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              {KIND_LABEL[b.kind] ?? b.kind} · {b.period_year}-{String(b.period_month).padStart(2, '0')} · staged {new Date(b.created_at).toLocaleDateString()}
              {b.source_file ? ` · ${b.source_file}` : ''}
            </div>
          </div>
        ))}
      </div>

      {/* batch detail + diff */}
      <div style={{ flex: 1, minWidth: 380 }}>
        {!sel && <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 30 }}>Select a batch to review its diff.</div>}
        {sel && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>{sel.label ?? propNames[sel.property_id]}</h2>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sel.period_year}-{String(sel.period_month).padStart(2, '0')} {KIND_LABEL[sel.kind] ?? sel.kind}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: STATUS_COLOR[sel.status], textTransform: 'uppercase' }}>{sel.status}</span>
              </div>
              {sel.summary && sel.kind === 'rentroll' && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  {fmtN(sel.summary.row_count)} occupied rows · leased {fmtN(sel.summary.leased_sf)} sf · annual base {fmt$(sel.summary.total_base_rent)} · avg {fmt$(sel.summary.avg_base_rent_psf)}/sf
                </div>
              )}
              {sel.summary && sel.kind === 'gl' && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  {fmtN(sel.summary.row_count)} entries · {fmtN(sel.summary.periods)} periods thru {sel.summary.max_period ?? '—'} · debits {fmt$(sel.summary.total_debit)} · credits {fmt$(sel.summary.total_credit)} · net {fmt$(sel.summary.net)}
                </div>
              )}
              {sel.decision_note && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>note: {sel.decision_note}</div>}
            </div>

            {diff?.replaces_existing_period && (
              <div style={{ border: '1px solid var(--red, #ef4444)', background: 'rgba(239,68,68,0.06)', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: 'var(--red, #ef4444)', fontWeight: 600 }}>
                {sel.kind === 'gl'
                  ? `⚠ ${fmtN(diff.periods_to_replace)} ledger period(s) differ from what is live — approving REPLACES those periods.`
                  : '⚠ A snapshot for this period already exists — approving REPLACES it.'}
              </div>
            )}

            {diff && sel.kind === 'gl' && (
              <>
                <div style={{ display: 'flex', gap: 14, fontSize: 12, flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--green, #22c55e)' }}>＋ {(diff.new_periods ?? []).length} new periods</span>
                  <span style={{ color: 'var(--amber, #f59e0b)' }}>Δ {(diff.changed_periods ?? []).length} changed</span>
                  <span style={{ color: 'var(--red, #ef4444)' }}>－ {(diff.removed_periods ?? []).length} removed</span>
                  <span style={{ color: 'var(--text-muted)' }}>{diff.unchanged_period_count ?? 0} unchanged</span>
                  <span style={{ color: 'var(--text-faint)', marginLeft: 'auto' }}>{fmtN(diff.staged_rows)} staged vs {fmtN(diff.live_rows)} live entries</span>
                </div>

                {(diff.changed_periods ?? []).length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--amber, #f59e0b)', marginBottom: 4 }}>Changed periods (live content differs from the file)</div>
                    {(diff.changed_periods ?? []).map((cp: any) => (
                      <div key={cp.period} style={{ border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 10px', marginBottom: 8 }}>
                        <div style={{ fontSize: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'baseline' }}>
                          <b>{cp.period}</b>
                          <span>net {fmt$(cp.old_net)} → <b>{fmt$(cp.new_net)}</b></span>
                          <span style={{ color: Number(cp.delta) === 0 ? 'var(--text-muted)' : 'var(--amber, #f59e0b)', fontWeight: 600 }}>Δ {fmt$(cp.delta)}</span>
                          <span style={{ color: 'var(--text-muted)' }}>{fmtN(cp.old_rows)} → {fmtN(cp.new_rows)} rows</span>
                        </div>
                        {(cp.accounts ?? []).length > 0 ? (
                          <div style={{ overflowX: 'auto', marginTop: 6 }}>
                            <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%' }}>
                              <thead><tr style={{ color: 'var(--text-faint)', textAlign: 'left' }}><th style={{ padding: '2px 8px' }}>Account</th><th style={{ padding: '2px 8px' }}>Name</th><th style={{ padding: '2px 8px' }}>Current net</th><th style={{ padding: '2px 8px' }}>Incoming net</th><th style={{ padding: '2px 8px' }}>Δ</th></tr></thead>
                              <tbody>
                                {(cp.accounts ?? []).map((a: any) => (
                                  <tr key={a.account} style={{ borderTop: '1px solid var(--border-1, rgba(128,128,128,0.15))' }}>
                                    <td style={{ padding: '2px 8px', fontWeight: 600 }}>{a.account}</td>
                                    <td style={{ padding: '2px 8px' }}>{a.name || '—'}</td>
                                    <td style={{ padding: '2px 8px' }}>{fmt$(a.old_net)}</td>
                                    <td style={{ padding: '2px 8px', fontWeight: 600 }}>{fmt$(a.new_net)}</td>
                                    <td style={{ padding: '2px 8px', color: 'var(--amber, #f59e0b)' }}>{fmt$(a.delta)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Row-level changes only — per-account nets are unchanged.</div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {(diff.new_periods ?? []).length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--green, #22c55e)', marginBottom: 4 }}>New periods (not in the live ledger)</div>
                    {(diff.new_periods ?? []).map((p: any) => (
                      <div key={p.period} style={{ fontSize: 12, padding: '2px 0' }}>
                        <b>{p.period}</b> · {fmtN(p.rows)} entries · net {fmt$(p.net)}
                      </div>
                    ))}
                  </div>
                )}

                {(diff.removed_periods ?? []).length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--red, #ef4444)', marginBottom: 4 }}>Removed periods (live has them, this file does not — unusual for a cumulative export)</div>
                    {(diff.removed_periods ?? []).map((p: any) => (
                      <div key={p.period} style={{ fontSize: 12, padding: '2px 0', color: 'var(--text-muted)' }}>
                        <b style={{ color: 'var(--text)' }}>{p.period}</b> · {fmtN(p.rows)} entries · net {fmt$(p.net)} — approving DELETES these
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {diff && sel.kind !== 'gl' && (
              <>
                <div style={{ display: 'flex', gap: 14, fontSize: 12 }}>
                  <span style={{ color: 'var(--green, #22c55e)' }}>＋ {(diff.new_tenants ?? []).length} new</span>
                  <span style={{ color: 'var(--amber, #f59e0b)' }}>Δ {(diff.changed ?? []).length} changed</span>
                  <span style={{ color: 'var(--red, #ef4444)' }}>－ {(diff.departed ?? []).length} departed</span>
                  <span style={{ color: 'var(--text-muted)' }}>{diff.unchanged_count ?? 0} unchanged</span>
                </div>

                {(diff.changed ?? []).length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--amber, #f59e0b)', marginBottom: 4 }}>Changed</div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%' }}>
                        <thead><tr style={{ color: 'var(--text-faint)', textAlign: 'left' }}><th style={{ padding: '3px 8px' }}>Tenant</th><th style={{ padding: '3px 8px' }}>Suite</th><th style={{ padding: '3px 8px' }}>Field</th><th style={{ padding: '3px 8px' }}>Current</th><th style={{ padding: '3px 8px' }}>Incoming</th></tr></thead>
                        <tbody>
                          {(diff.changed ?? []).flatMap((c: any) =>
                            Object.entries(c.changes ?? {}).map(([f, v]: [string, any], i: number) => (
                              <tr key={`${c.tenant}-${f}`} style={{ borderTop: '1px solid var(--border-1, rgba(128,128,128,0.15))' }}>
                                <td style={{ padding: '3px 8px', fontWeight: i === 0 ? 600 : 400 }}>{i === 0 ? c.tenant : ''}</td>
                                <td style={{ padding: '3px 8px' }}>{i === 0 ? c.suite : ''}</td>
                                <td style={{ padding: '3px 8px', color: 'var(--accent)' }}>{f}</td>
                                <td style={{ padding: '3px 8px' }}>{String(v?.old ?? '—')}</td>
                                <td style={{ padding: '3px 8px', fontWeight: 600 }}>{String(v?.new ?? '—')}</td>
                              </tr>
                            )))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {(diff.new_tenants ?? []).length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--green, #22c55e)', marginBottom: 4 }}>New tenants</div>
                    {(diff.new_tenants ?? []).map((t: any, i: number) => (
                      <div key={i} style={{ fontSize: 12, padding: '2px 0' }}>
                        <b>{t.tenant_name}</b> · suite {t.suite ?? '—'} · {fmtN(t.sqft)} sf · {fmt$(t.monthly_base_rent)}/mo · {t.lease_start ?? '—'} → {t.lease_end ?? '—'}
                      </div>
                    ))}
                  </div>
                )}

                {(diff.departed ?? []).length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--red, #ef4444)', marginBottom: 4 }}>Departed (in current snapshot, absent from this file)</div>
                    {(diff.departed ?? []).map((t: any, i: number) => (
                      <div key={i} style={{ fontSize: 12, padding: '2px 0', color: 'var(--text-muted)' }}>
                        <b style={{ color: 'var(--text)' }}>{t.tenant_name}</b> · suite {t.suite ?? '—'} · {fmtN(t.sqft)} sf{t.monthly_base_rent != null ? ` · ${fmt$(t.monthly_base_rent)}/mo` : ''}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            {!diff && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No diff stored for this batch (loader computes it at stage time).</div>}

            {(sel.status === 'staged' || sel.status === 'approved') && (
              <div style={{ borderTop: '1px solid var(--border-2)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <input value={note} onChange={e => setNote(e.target.value)} placeholder="decision note (kept on the batch)"
                  style={{ fontSize: 12, padding: '6px 8px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }} />
                {actErr && <div style={{ fontSize: 12, color: 'var(--red)' }}>{actErr}</div>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button disabled={busy} onClick={() => void approve()}
                    style={{ fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, border: 'none', background: 'var(--green, #22c55e)', color: '#fff', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
                    {busy ? '…' : 'Approve & apply'}
                  </button>
                  <button disabled={busy} onClick={() => void reject()}
                    style={{ fontSize: 12, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border-2)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
                    Reject
                  </button>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                  {sel.kind === 'gl'
                    ? 'Approving replaces only the differing ledger periods atomically and refreshes the P&L matviews in the same transaction.'
                    : "Approving replaces the period's snapshot atomically. After applying a rent roll, run reconcile_option_notices.ps1 (option-date sync)."}
                </div>
              </div>
            )}
            {sel.status === 'applied' && (
              <div style={{ fontSize: 12, color: 'var(--green, #22c55e)' }}>
                ✓ Applied {sel.applied_at ? new Date(sel.applied_at).toLocaleString() : ''}.{' '}
                {sel.kind === 'gl' ? 'P&L matviews were refreshed with the apply.' : 'Reminder: run reconcile_option_notices.ps1 after rent-roll loads.'}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
