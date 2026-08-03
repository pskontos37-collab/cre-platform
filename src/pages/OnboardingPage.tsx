import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { usePortfolios } from '../hooks/useProperties'
import { useCan } from '../lib/useActions'
import {
  REQUIRED_DOCS, completeOnboarding, createDraft, deleteDraft, fetchDraftDocs,
  parseRentRollFile, saveDraft, uploadOnboardingDoc, useOnboardingDrafts,
  type GoLiveResult, type OnboardingDocRow, type OnboardingDraft, type OnboardingIdentity,
  type StagedRentRoll,
} from '../hooks/useOnboarding'
import type { RentRollParse } from '../lib/rentRollParse'

// ── Property onboarding wizard (/onboarding) ─────────────────────────────────
// Self-serve version of the script-driven onboarding recipe. Five steps, all
// resumable, and deliberately non-destructive until the final typed
// confirmation: documents register against no property, the rent roll is parsed
// and cross-checked in the browser but only STAGED (approved later on /imports),
// and the property row itself is created by one atomic RPC.

const STEPS = [
  { n: 1, label: 'Property' },
  { n: 2, label: 'Documents' },
  { n: 3, label: 'File room' },
  { n: 4, label: 'Rent roll' },
  { n: 5, label: 'Review' },
]

const ASSET_TYPES: { value: 'retail' | 'office' | 'mixed_use'; label: string }[] = [
  { value: 'retail', label: 'Retail' },
  { value: 'office', label: 'Office' },
  { value: 'mixed_use', label: 'Mixed use' },
]

const label: CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-faint)', display: 'block', marginBottom: 3 }
const input: CSSProperties = { width: '100%', fontSize: 13, padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border-2)', background: 'var(--surface-2)', color: 'var(--text)' }
const card: CSSProperties = { border: '1px solid var(--border-2)', borderRadius: 10, padding: 16 }
function btn(kind: 'primary' | 'ghost' | 'danger' = 'ghost'): CSSProperties {
  const base: CSSProperties = { fontSize: 13, fontWeight: 600, padding: '7px 14px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border-2)' }
  if (kind === 'primary') return { ...base, background: 'var(--accent)', color: '#fff', border: 'none' }
  if (kind === 'danger') return { ...base, background: 'transparent', color: 'var(--red, #ef4444)', border: '1px solid var(--red, #ef4444)' }
  return { ...base, background: 'transparent', color: 'var(--text)' }
}
const fmtN = (n: unknown) => (n == null ? '—' : Number(n).toLocaleString('en-US'))
const fmt$ = (n: unknown) => (n == null ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }))

export function OnboardingPage() {
  const canOnboard = useCan('properties.onboard')
  const { data: drafts, loading, error, refetch } = useOnboardingDrafts()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const active = useMemo(() => drafts.find(d => d.id === activeId) ?? null, [drafts, activeId])

  async function startDraft() {
    setBusy(true); setMsg(null)
    try {
      const id = await createDraft(newName)
      setNewName('')
      await refetch()
      setActiveId(id)
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (canOnboard === false) {
    return (
      <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 560, lineHeight: 1.6 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>Onboard a property</h2>
        Your account does not hold the "Onboard properties" action. An admin can grant it per user
        on the Admin page (Users &rarr; Edit &rarr; Action grants).
      </div>
    )
  }

  if (active) {
    return (
      <Wizard
        key={active.id}
        draft={active}
        onClose={() => { setActiveId(null); void refetch() }}
        onSaved={refetch}
      />
    )
  }

  const open = drafts.filter(d => d.status === 'draft')
  const done = drafts.filter(d => d.status !== 'draft')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 780 }}>
      <div>
        <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>Onboard a property</h2>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.6 }}>
          Creates the asset, files its closing documents, links its file room, and stages the first
          MRI rent roll. Nothing touches live portfolio data until the final step, and onboarding can
          be paused and resumed as documents arrive.
        </p>
      </div>

      <div style={{ ...card, display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <span style={label}>Property name</span>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. Riverpark Village"
            onKeyDown={e => { if (e.key === 'Enter' && newName.trim()) void startDraft() }} style={input} />
        </div>
        <button style={btn('primary')} disabled={busy || !newName.trim()} onClick={() => void startDraft()}>
          {busy ? 'Starting…' : 'Start onboarding'}
        </button>
      </div>
      {msg && <div style={{ fontSize: 12, color: 'var(--red)' }}>{msg}</div>}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
      {loading && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>}

      {open.length > 0 && (
        <div>
          <div style={{ ...label, marginBottom: 6 }}>In progress</div>
          {open.map(d => (
            <div key={d.id} onClick={() => setActiveId(d.id)}
              style={{ ...card, marginBottom: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>{d.identity?.name || d.working_name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  step {d.step} of 5 · {d.doc_ids?.length ?? 0} documents · {d.rr ? `${fmtN(d.rr.summary?.row_count)} rent-roll rows staged` : 'no rent roll yet'}
                  {' · '}updated {new Date(d.updated_at).toLocaleDateString()}
                </div>
              </div>
              <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>Resume →</span>
            </div>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <div>
          <div style={{ ...label, marginBottom: 6 }}>Completed</div>
          {done.map(d => (
            <div key={d.id} style={{ fontSize: 12, padding: '3px 0', color: 'var(--text-muted)' }}>
              <span style={{ color: 'var(--green, #22c55e)' }}>✓</span>{' '}
              <b style={{ color: 'var(--text)' }}>{d.identity?.name || d.working_name}</b>
              {d.completed_at ? ` · ${new Date(d.completed_at).toLocaleDateString()}` : ''}
              {d.property_id && <> · <Link to="/properties" style={{ color: 'var(--accent)' }}>open in Properties</Link></>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════

function Wizard({ draft, onClose, onSaved }: {
  draft: OnboardingDraft
  onClose: () => void
  onSaved: () => Promise<void> | void
}) {
  const { data: portfolios } = usePortfolios()
  const [step, setStep] = useState(draft.step || 1)
  const [ident, setIdent] = useState<OnboardingIdentity>(draft.identity ?? {})
  const [keywords, setKeywords] = useState((draft.route_keywords ?? []).join(', '))
  const [roomPath, setRoomPath] = useState(draft.file_room_path ?? '')
  const [docIds, setDocIds] = useState<string[]>(draft.doc_ids ?? [])
  const [docs, setDocs] = useState<OnboardingDocRow[]>([])
  const [rr, setRr] = useState<StagedRentRoll | null>(draft.rr ?? null)
  const [parse, setParse] = useState<RentRollParse | null>(null)
  const [period, setPeriod] = useState(() => {
    const now = new Date()
    return {
      year: draft.rr?.period_year ?? now.getUTCFullYear(),
      month: draft.rr?.period_month ?? now.getUTCMonth() + 1,
    }
  })
  const [confirmName, setConfirmName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<GoLiveResult | null>(null)

  const loadDocs = useCallback(async () => {
    try { setDocs(await fetchDraftDocs(docIds)) } catch { /* listing is advisory */ }
  }, [docIds])
  useEffect(() => { void loadDocs() }, [loadDocs])

  const nameOk = !!(ident.name ?? '').trim()
  const assetOk = !!ident.asset_type
  const identityOk = nameOk && assetOk

  /** Returns false when the save failed, so navigation can stay put. */
  async function persist(patch: Partial<OnboardingDraft>, note?: string): Promise<boolean> {
    setBusy(note ?? 'saving'); setErr(null)
    try {
      await saveDraft(draft.id, patch)
      await onSaved()
      return true
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(null)
    }
  }

  function keywordList(): string[] {
    return keywords.split(',').map(k => k.trim().toLowerCase()).filter(k => k.length >= 4)
  }

  async function goStep(n: number) {
    const patch: Partial<OnboardingDraft> = { step: n }
    if (step === 1) {
      patch.identity = ident
      patch.working_name = (ident.name ?? '').trim() || 'Untitled property'
      patch.route_keywords = keywordList()
    }
    if (step === 3) patch.file_room_path = roomPath.trim() || null
    // don't advance past a step whose edits failed to save
    if (await persist(patch)) setStep(n)
  }

  async function onUpload(file: File, docType: string, subtype: string) {
    setBusy('upload:' + subtype); setErr(null)
    try {
      const id = await uploadOnboardingDoc(draft.id, file, docType, subtype)
      const next = [...docIds, id]
      setDocIds(next)
      await saveDraft(draft.id, { doc_ids: next })
      await onSaved()
      setDocs(await fetchDraftDocs(next))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function onPickRentRoll(file: File) {
    setBusy('rr'); setErr(null); setParse(null)
    try {
      const p = await parseRentRollFile(file)
      setParse(p)
      if (p.errors.length === 0) {
        const staged: StagedRentRoll = {
          period_year: period.year, period_month: period.month,
          source_file: file.name, summary: p.summary, rows: p.rows,
          file_total_monthly: p.file_total_monthly, total_variance: p.total_variance,
        }
        setRr(staged)
        await saveDraft(draft.id, { rr: staged })
        await onSaved()
      } else {
        // a file that does not tie to its own totals is never staged
        setRr(null)
        await saveDraft(draft.id, { rr: null })
        await onSaved()
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  async function goLive() {
    setBusy('golive'); setErr(null)
    try {
      // keep the period the reviewer just confirmed on the staged payload
      if (rr && (rr.period_year !== period.year || rr.period_month !== period.month)) {
        const fixed = { ...rr, period_year: period.year, period_month: period.month }
        setRr(fixed)
        await saveDraft(draft.id, { rr: fixed })
      }
      const res = await completeOnboarding(draft.id, confirmName)
      setResult(res)
      await onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const docBySubtype = useMemo(() => {
    const m: Record<string, OnboardingDocRow[]> = {}
    for (const d of docs) {
      const k = d.doc_subtype ?? 'other'
      m[k] = m[k] ?? []
      m[k].push(d)
    }
    return m
  }, [docs])

  const onFile = (cb: (f: File) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) cb(f)
  }

  if (result) {
    return (
      <div style={{ maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: 'var(--green, #22c55e)' }}>
          ✓ {ident.name} is live
        </h2>
        <div style={{ ...card, fontSize: 13, lineHeight: 1.8 }}>
          <div>Property created and added to the portfolio.</div>
          <div>{result.documents_attached} document(s) now filed under it.</div>
          <div>
            {result.rent_roll_rows > 0
              ? <>Rent roll staged ({fmtN(result.rent_roll_rows)} rows) — <Link to="/imports" style={{ color: 'var(--accent)', fontWeight: 600 }}>review and approve it on MRI Imports</Link>.</>
              : 'No rent roll was staged.'}
          </div>
          {(result.keywords_added?.length ?? 0) > 0 && <div>Routing keywords added: {result.keywords_added.join(', ')}.</div>}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          Next: approve the staged rent roll, then the document pipeline picks up the file room on its
          nightly run. Lease abstraction is a separate, priced step — ask before it runs.
        </div>
        <div>
          <button style={btn('primary')} onClick={onClose}>Done</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 780, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>{ident.name || draft.working_name}</h2>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>onboarding draft</span>
        <button style={{ ...btn(), marginLeft: 'auto' }} onClick={() => { void persist({ identity: ident, route_keywords: keywordList(), file_room_path: roomPath.trim() || null, step }); onClose() }}>
          Save &amp; close
        </button>
      </div>

      {/* step rail */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {STEPS.map(s => (
          <button key={s.n} onClick={() => void goStep(s.n)}
            style={{
              fontSize: 12, padding: '5px 12px', borderRadius: 20, cursor: 'pointer',
              fontWeight: step === s.n ? 700 : 400,
              border: `1px solid ${step === s.n ? 'var(--accent)' : 'var(--border-2)'}`,
              background: step === s.n ? 'var(--surface-2)' : 'transparent', color: 'var(--text)',
            }}>
            {s.n}. {s.label}
          </button>
        ))}
      </div>

      {err && <div style={{ fontSize: 12, color: 'var(--red)' }}>{err}</div>}

      {/* ── 1. identity ── */}
      {step === 1 && (
        <div style={{ ...card, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <span style={label}>Property name *</span>
            <input style={input} value={ident.name ?? ''} onChange={e => setIdent({ ...ident, name: e.target.value })} />
          </div>
          <div>
            <span style={label}>Asset type *</span>
            <select style={input} value={ident.asset_type ?? ''} onChange={e => setIdent({ ...ident, asset_type: e.target.value as OnboardingIdentity['asset_type'] })}>
              <option value="">Choose…</option>
              {ASSET_TYPES.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </div>
          <div>
            <span style={label}>Capital partner / portfolio</span>
            <select style={input} value={ident.portfolio_id ?? ''} onChange={e => setIdent({ ...ident, portfolio_id: e.target.value })}>
              <option value="">Unassigned</option>
              {(portfolios ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <span style={label}>Address</span>
            <input style={input} value={ident.address ?? ''} onChange={e => setIdent({ ...ident, address: e.target.value })} />
          </div>
          <div><span style={label}>City</span><input style={input} value={ident.city ?? ''} onChange={e => setIdent({ ...ident, city: e.target.value })} /></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}><span style={label}>State</span><input style={input} value={ident.state ?? ''} onChange={e => setIdent({ ...ident, state: e.target.value })} /></div>
            <div style={{ flex: 1 }}><span style={label}>ZIP</span><input style={input} value={ident.zip ?? ''} onChange={e => setIdent({ ...ident, zip: e.target.value })} /></div>
          </div>
          <div><span style={label}>Total SF</span><input style={input} inputMode="numeric" value={ident.total_sf ?? ''} onChange={e => setIdent({ ...ident, total_sf: e.target.value })} /></div>
          <div><span style={label}>Year built</span><input style={input} inputMode="numeric" value={ident.year_built ?? ''} onChange={e => setIdent({ ...ident, year_built: e.target.value })} /></div>
          <div><span style={label}>Acquisition date</span><input style={input} type="date" value={ident.acquisition_date ?? ''} onChange={e => setIdent({ ...ident, acquisition_date: e.target.value })} /></div>
          <div><span style={label}>Acquisition price</span><input style={input} inputMode="numeric" value={ident.acquisition_price ?? ''} onChange={e => setIdent({ ...ident, acquisition_price: e.target.value })} /></div>
          <div><span style={label}>Management company</span><input style={input} value={ident.management_company ?? ''} onChange={e => setIdent({ ...ident, management_company: e.target.value })} /></div>
          <div><span style={label}>JV partner</span><input style={input} value={ident.jv_partner ?? ''} onChange={e => setIdent({ ...ident, jv_partner: e.target.value })} /></div>
          <div style={{ gridColumn: '1 / -1' }}>
            <span style={label}>Routing keywords</span>
            <input style={input} value={keywords} onChange={e => setKeywords(e.target.value)} placeholder="riverpark, riverpark village" />
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 3 }}>
              Comma-separated, 4+ characters. Insurance certificates and folder names containing these
              route to this property automatically. Added at go-live; existing keywords are never changed.
            </div>
          </div>
        </div>
      )}

      {/* ── 2. required documents ── */}
      {step === 2 && (
        <div style={{ ...card }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.6 }}>
            The closing set. Every file is registered immediately and shows up in Document Control;
            anything still missing stays visible there rather than being forgotten. None of it blocks go-live.
          </div>
          <table style={{ fontSize: 13, borderCollapse: 'collapse', width: '100%' }}>
            <tbody>
              {REQUIRED_DOCS.map(rd => {
                const have = docBySubtype[rd.key] ?? []
                return (
                  <tr key={rd.key} style={{ borderTop: '1px solid var(--border-1, rgba(128,128,128,0.15))' }}>
                    <td style={{ padding: '6px 8px', width: 24 }}>
                      {have.length > 0 ? <span style={{ color: 'var(--green, #22c55e)' }}>✓</span> : <span style={{ color: 'var(--text-faint)' }}>○</span>}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      <div style={{ fontWeight: 600 }}>{rd.label}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{rd.hint}</div>
                      {have.map(h => (
                        <div key={h.id} style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                          {h.file_name ?? h.title}{h.file_size_bytes ? ` · ${(h.file_size_bytes / 1048576).toFixed(1)} MB` : ''}
                        </div>
                      ))}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <label style={{ ...btn(), display: 'inline-block' }}>
                        {busy === 'upload:' + rd.key ? 'Uploading…' : have.length ? 'Add another' : 'Upload'}
                        <input type="file" style={{ display: 'none' }}
                          onChange={onFile(f => void onUpload(f, rd.docType, rd.key))} />
                      </label>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
            {Object.keys(docBySubtype).length} of {REQUIRED_DOCS.length} categories on file
            {docs.length > 0 ? ` · ${docs.length} document(s) staged` : ''}
          </div>
        </div>
      )}

      {/* ── 3. file room ── */}
      {step === 3 && (
        <div style={{ ...card }}>
          <span style={label}>File-room folder</span>
          <input style={input} value={roomPath} onChange={e => setRoomPath(e.target.value)}
            placeholder="V:\Riverpark Village 3-1-26  or  \\192.168.220.121\virtual_file_room\..." />
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.6 }}>
            Paste the property's root folder on the file server. The document pipeline reads it on its
            nightly run and ingests everything under it — leases, amendments, correspondence — so the
            bulk corpus never comes through the browser.
          </div>
          {roomPath.trim() && !/^([A-Za-z]:\\|\\\\)/.test(roomPath.trim()) && (
            <div style={{ fontSize: 12, color: 'var(--amber, #f59e0b)', marginTop: 8 }}>
              That does not look like a Windows path or UNC share — double-check it before go-live.
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 8 }}>
            Tenant-folder name checks (catching "Wild Wing" vs "Wild Wings" style mismatches before
            ingest) come with the scan-root automation; for now the path is recorded here and the
            first scan reports what it matched.
          </div>
        </div>
      )}

      {/* ── 4. rent roll ── */}
      {step === 4 && (
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <span style={label}>As-of year</span>
              <input style={{ ...input, width: 90 }} inputMode="numeric" value={period.year}
                onChange={e => setPeriod({ ...period, year: Number(e.target.value) || period.year })} />
            </div>
            <div>
              <span style={label}>Month</span>
              <select style={{ ...input, width: 90 }} value={period.month}
                onChange={e => setPeriod({ ...period, month: Number(e.target.value) })}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map(mo => <option key={mo} value={mo}>{mo}</option>)}
              </select>
            </div>
            <label style={{ ...btn('primary'), display: 'inline-block' }}>
              {busy === 'rr' ? 'Reading…' : 'Choose MRI rent roll (.xlsx)'}
              <input type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
                onChange={onFile(f => void onPickRentRoll(f))} />
            </label>
          </div>

          {parse && parse.errors.length > 0 && (
            <div style={{ border: '1px solid var(--red, #ef4444)', background: 'rgba(239,68,68,0.06)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--red, #ef4444)', marginBottom: 4 }}>This file was not staged</div>
              {parse.errors.map((x, i) => <div key={i} style={{ fontSize: 12, color: 'var(--red, #ef4444)' }}>{x}</div>)}
            </div>
          )}
          {parse && parse.warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 12, color: 'var(--amber, #f59e0b)' }}>⚠ {w}</div>
          ))}

          {rr && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--green, #22c55e)', marginBottom: 6 }}>
                ✓ Parsed and tied to the file's own total — staged for review
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.8 }}>
                <div>{rr.source_file} · as of {rr.period_year}-{String(rr.period_month).padStart(2, '0')}</div>
                <div>
                  {fmtN(rr.summary.occupied_units)} occupied units · {fmtN(rr.summary.vacant_count)} vacant ·
                  leased {fmtN(rr.summary.leased_sf)} SF of {fmtN(rr.summary.total_sf)} SF
                  ({rr.summary.occupancy_pct != null ? `${(rr.summary.occupancy_pct * 100).toFixed(1)}%` : '—'} occupied)
                </div>
                <div>
                  annual base rent {fmt$(rr.summary.total_base_rent)} · average {fmt$(rr.summary.avg_base_rent_psf)}/SF
                </div>
              </div>
              <div style={{ overflowX: 'auto', marginTop: 8 }}>
                <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%' }}>
                  <thead><tr style={{ color: 'var(--text-faint)', textAlign: 'left' }}>
                    <th style={{ padding: '3px 8px' }}>Suite</th><th style={{ padding: '3px 8px' }}>Tenant</th>
                    <th style={{ padding: '3px 8px' }}>SF</th><th style={{ padding: '3px 8px' }}>Monthly</th>
                    <th style={{ padding: '3px 8px' }}>Term</th>
                  </tr></thead>
                  <tbody>
                    {rr.rows.slice(0, 12).map((r, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--border-1, rgba(128,128,128,0.15))', color: r.is_occupied ? 'var(--text)' : 'var(--text-muted)' }}>
                        <td style={{ padding: '3px 8px' }}>{r.suite}</td>
                        <td style={{ padding: '3px 8px' }}>{r.tenant_name ?? '—'}</td>
                        <td style={{ padding: '3px 8px' }}>{fmtN(r.sqft)}</td>
                        <td style={{ padding: '3px 8px' }}>{r.monthly_base_rent == null ? '—' : fmt$(r.monthly_base_rent)}</td>
                        <td style={{ padding: '3px 8px' }}>{r.lease_start ?? '—'} → {r.lease_end ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rr.rows.length > 12 && (
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', padding: '4px 8px' }}>
                    and {rr.rows.length - 12} more row(s) — the full set stages for approval.
                  </div>
                )}
              </div>
            </div>
          )}

          <div style={{ fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.6 }}>
            The workbook is parsed here in the browser and cross-checked against its own Totals row.
            At go-live it becomes a STAGED import — you approve it on MRI Imports, exactly like a
            monthly drop, so nothing lands unreviewed. GL loads stay on the scripted path for now.
          </div>
        </div>
      )}

      {/* ── 5. review + go live ── */}
      {step === 5 && (
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13, lineHeight: 1.9 }}>
            <Check ok={identityOk} text={identityOk
              ? `${ident.name} · ${ASSET_TYPES.find(a => a.value === ident.asset_type)?.label}${ident.city ? ` · ${ident.city}${ident.state ? ', ' + ident.state : ''}` : ''}`
              : 'Property name and asset type are required (step 1)'} />
            <Check ok={docs.length > 0} soft text={docs.length > 0
              ? `${docs.length} document(s) filed across ${Object.keys(docBySubtype).length} categories`
              : 'No documents filed yet — you can add them later'} />
            <Check ok={!!roomPath.trim()} soft text={roomPath.trim()
              ? `File room: ${roomPath.trim()}`
              : 'No file-room folder linked — the corpus stays empty until one is'} />
            <Check ok={!!rr} soft text={rr
              ? `Rent roll ready to stage: ${fmtN(rr.summary.row_count)} occupied rows, ${fmt$(rr.summary.total_base_rent)} annual base, as of ${period.year}-${String(period.month).padStart(2, '0')}`
              : 'No rent roll staged — occupancy and rent stay empty until one is loaded'} />
            <Check ok={keywordList().length > 0} soft text={keywordList().length > 0
              ? `Routing keywords: ${keywordList().join(', ')}`
              : 'No routing keywords — certificates and folders will not auto-route'} />
          </div>

          {/* The standing checks (v_property_data_quality, migration 20240181) run on
              stored data, so they have nothing to read until the property exists.
              Name them here so the day-one review is part of the process rather than
              something someone has to remember to go looking for. */}
          <div style={{ borderTop: '1px solid var(--border-2)', paddingTop: 12, fontSize: 11, color: 'var(--text-faint)', lineHeight: 1.7 }}>
            <span style={{ fontWeight: 700, color: 'var(--text-muted)' }}>After go-live:</span> the
            property page runs a standing <span style={{ fontWeight: 650 }}>Data Quality</span> panel
            over whatever lands — rent-roll recency, rent schedules that disagree with their own term,
            rights asserted from an unpopulated MRI flag, allowances sitting in a brief but missing
            from the abstract, verifier quotes that cannot be found in the source, and no-op reviewer
            overrides. Those checks are plain SQL over stored data, so they cost nothing and are
            always current. Work them from the Review Center; a resolution there settles them
            everywhere.
          </div>

          <div style={{ borderTop: '1px solid var(--border-2)', paddingTop: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.6 }}>
              Creating the property is not reversible from here — documents and financials will hang
              off it. Type the property name to confirm.
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <input style={{ ...input, maxWidth: 320 }} value={confirmName}
                onChange={e => setConfirmName(e.target.value)} placeholder={ident.name ?? 'Property name'} />
              <button style={btn('primary')}
                disabled={!identityOk || busy === 'golive' || confirmName.trim() !== (ident.name ?? '').trim()}
                onClick={() => void goLive()}>
                {busy === 'golive' ? 'Creating…' : 'Create property'}
              </button>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border-2)', paddingTop: 10 }}>
            <button style={btn('danger')} onClick={() => {
              if (!confirm('Discard this onboarding draft? Documents already uploaded stay in the register (unassigned) and can be attached to a property later.')) return
              void (async () => {
                try { await deleteDraft(draft.id); onClose() }
                catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
              })()
            }}>Discard draft</button>
          </div>
        </div>
      )}

      {/* footer nav */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btn()} disabled={step <= 1} onClick={() => void goStep(step - 1)}>← Back</button>
        <button style={btn('primary')} disabled={step >= 5 || (step === 1 && !identityOk)}
          onClick={() => void goStep(step + 1)}>
          {busy === 'saving' ? 'Saving…' : 'Next →'}
        </button>
      </div>
    </div>
  )
}

function Check({ ok, text, soft }: { ok: boolean; text: string; soft?: boolean }) {
  const color = ok ? 'var(--green, #22c55e)' : soft ? 'var(--amber, #f59e0b)' : 'var(--red, #ef4444)'
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ color, fontWeight: 700 }}>{ok ? '✓' : soft ? '○' : '✕'}</span>
      <span style={{ color: ok ? 'var(--text)' : 'var(--text-muted)' }}>{text}</span>
    </div>
  )
}
