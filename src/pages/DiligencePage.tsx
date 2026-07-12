import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import { supabase } from '../lib/supabase'
import { useQuery } from '../hooks/useQuery'
import { Widget, WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'
import { AbstractView } from './AbstractsPage'

// /diligence — DUE-DILIGENCE workspace for acquisitions. Runs the full lease-
// intelligence pipeline on TARGET deals that are not (yet) AUM:
//   1. create a DD deal (a shell property with is_pipeline=true — excluded from
//      every AUM surface by useProperties)
//   2. upload the data-room leases (doc-inbox fn: stores + extracts + files rows)
//   3. abstract + adversarially verify per tenant — same engine, same QA
//   4. on close, PROMOTE: is_pipeline=false and the DD abstracts/documents become
//      day-1 AUM data with zero rework.
// Clause benchmarking vs the owned portfolio comes free on /clauses because the
// abstracts share one table.

const FN_BASE = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`

interface DdProperty { id: string; name: string; asset_type: string; created_at: string }
interface DdDoc { id: string; title: string | null; file_name: string | null; doc_type: string }
interface AbstractRow { [k: string]: any }

export function DiligencePage() {
  const { appUser } = useAuth()
  const [bump, setBump] = useState(0)
  // ?deal=<shell property id> — the pipeline's one-click Diligence bridge lands here
  const [searchParams] = useSearchParams()
  const [selectedDeal, setSelectedDeal] = useState<string | null>(searchParams.get('deal'))

  const deals = useQuery<DdProperty[]>(async () => {
    const { data, error } = await supabase.from('properties')
      .select('id, name, asset_type, created_at')
      .eq('is_pipeline', true).order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    return (data ?? []) as DdProperty[]
  }, [bump])

  if (appUser?.role !== 'admin' && appUser?.role !== 'asset_manager') {
    return <div style={{ padding: '40px 32px', color: 'var(--text-muted)', fontSize: 14 }}>You need admin or asset manager access to view the diligence workspace.</div>
  }

  const deal = (deals.data ?? []).find(d => d.id === selectedDeal) ?? null

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1200 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Due Diligence</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18 }}>
        Abstract and verify an acquisition target's leases before you own them — upload the data room, run the same
        abstract + adversarial-QA engine as AUM, and benchmark the target's clauses on /clauses. Deals here never
        touch AUM dashboards; promoting a closed deal carries its abstracts in as day-1 data.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <NewDealForm onCreated={id => { setBump(b => b + 1); setSelectedDeal(id) }} />
          <Widget title="Deals in diligence" chip={`${deals.data?.length ?? 0}`}>
            {deals.loading && <WidgetSkeleton rows={4} />}
            {!deals.loading && !(deals.data ?? []).length && <EmptyState icon="🔎" title="No deals yet" subtitle="Create one above to start" />}
            {(deals.data ?? []).map(d => (
              <div key={d.id} onClick={() => setSelectedDeal(d.id)}
                style={{ padding: '7px 9px', borderRadius: 6, cursor: 'pointer', marginBottom: 2,
                  background: selectedDeal === d.id ? 'var(--accent-dim)' : 'transparent' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: selectedDeal === d.id ? 'var(--accent)' : 'var(--text)' }}>{d.name}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{d.asset_type} · opened {new Date(d.created_at).toLocaleDateString()}</div>
              </div>
            ))}
          </Widget>
        </div>

        <div>
          {!deal
            ? <Widget title="Deal workspace"><EmptyState icon="📂" title="Pick or create a deal" subtitle="The data room, abstracts, and QA live here" /></Widget>
            : <DealWorkspace key={deal.id} deal={deal} reviewerId={appUser?.id} onChanged={() => setBump(b => b + 1)} onPromoted={() => { setSelectedDeal(null); setBump(b => b + 1) }} />}
        </div>
      </div>
    </div>
  )
}

function NewDealForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('')
  const [assetType, setAssetType] = useState('retail')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  async function create() {
    if (name.trim().length < 3 || busy) return
    setBusy(true); setErr(null)
    try {
      const { data, error } = await supabase.from('properties')
        .insert({ name: name.trim(), asset_type: assetType, is_pipeline: true, ownership_type: 'owned', notes: 'DD shell — created from /diligence' })
        .select('id').single()
      if (error) throw new Error(error.message)
      setName('')
      onCreated(data.id)
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return (
    <Widget title="New DD deal">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Target name — e.g. Riverchase Commons"
          style={{ fontSize: 12, padding: '7px 10px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }} />
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={assetType} onChange={e => setAssetType(e.target.value)}
            style={{ flex: 1, fontSize: 12, padding: '6px 9px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }}>
            <option value="retail">retail</option><option value="office">office</option>
          </select>
          <button onClick={() => void create()} disabled={busy || name.trim().length < 3}
            style={{ fontSize: 12, fontWeight: 600, padding: '6px 16px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer' }}>
            {busy ? '…' : 'Create'}
          </button>
        </div>
        {err && <div style={{ fontSize: 11, color: 'var(--red)' }}>{err}</div>}
      </div>
    </Widget>
  )
}

function DealWorkspace({ deal, reviewerId, onChanged, onPromoted }: {
  deal: DdProperty; reviewerId?: string; onChanged: () => void; onPromoted: () => void
}) {
  const [bump, setBump] = useState(0)
  const docs = useQuery<DdDoc[]>(async () => {
    const { data, error } = await supabase.from('documents')
      .select('id, title, file_name, doc_type').eq('property_id', deal.id)
      .order('created_at', { ascending: false }).limit(500)
    if (error) throw new Error(error.message)
    return (data ?? []) as DdDoc[]
  }, [deal.id, bump])
  const abstracts = useQuery<AbstractRow[]>(async () => {
    const { data, error } = await supabase.from('lease_abstracts')
      .select('id, tenant_name, status, abstract, generated_at, source_doc_ids, error, qa, qa_status, qa_at, overrides, human_verified, locked, reviewed_at, review_note')
      .eq('property_id', deal.id).order('tenant_name')
    if (error) throw new Error(error.message)
    return (data ?? []) as AbstractRow[]
  }, [deal.id, bump])

  const [uploading, setUploading] = useState<string | null>(null)
  const [tenant, setTenant] = useState('')
  const [working, setWorking] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [openTenant, setOpenTenant] = useState<string | null>(null)

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return
    setErr(null)
    const { data: { session } } = await supabase.auth.getSession()
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      setUploading(`${i + 1}/${files.length}: ${f.name}`)
      try {
        const buf = new Uint8Array(await f.arrayBuffer())
        let bin = ''
        for (let j = 0; j < buf.length; j += 0x8000) bin += String.fromCharCode(...buf.subarray(j, j + 0x8000))
        const res = await fetch(`${FN_BASE}/doc-inbox`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${session?.access_token ?? ''}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ property_id: deal.id, file_name: f.name, pdf_base64: btoa(bin) }),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok || json.error) throw new Error(json.error ?? `upload failed (${res.status})`)
      } catch (e) {
        setErr(`${f.name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    setUploading(null)
    setBump(b => b + 1)
  }

  async function callFn(slug: string, tenantName: string) {
    const { data: { session } } = await supabase.auth.getSession()
    const res = await fetch(`${FN_BASE}/${slug}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session?.access_token ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ property_id: deal.id, tenant: tenantName }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || json.error) throw new Error(json.error ?? `${slug} failed (${res.status})`)
  }
  async function abstractTenant(tenantName: string) {
    const t = tenantName.trim()
    if (t.length < 3 || working) return
    setWorking(t); setErr(null)
    try {
      await callFn('lease-abstract', t)
      await callFn('abstract-verify', t)
      setTenant(''); setOpenTenant(t)
    } catch (e) { setErr(`${t}: ${e instanceof Error ? e.message : String(e)}`) }
    finally { setWorking(null); setBump(b => b + 1) }
  }

  async function promote() {
    if (!window.confirm(`Promote "${deal.name}" to AUM? It will appear across the app; its DD abstracts and documents carry over.`)) return
    const { error } = await supabase.from('properties')
      .update({ is_pipeline: false, acquisition_date: new Date().toISOString().slice(0, 10) })
      .eq('id', deal.id)
    if (error) { setErr(error.message); return }
    onPromoted(); onChanged()
  }

  const openRow = openTenant ? (abstracts.data ?? []).find(a => a.tenant_name === openTenant) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{deal.name}</span>
        <button onClick={() => void promote()}
          style={{ fontSize: 11, fontWeight: 600, padding: '5px 14px', borderRadius: 6, border: '1px solid var(--green, #22c55e)', background: 'rgba(34,197,94,0.12)', color: 'var(--green, #22c55e)', cursor: 'pointer' }}>
          Deal closed — promote to AUM
        </button>
      </div>

      <Widget title="Data room" chip={`${docs.data?.length ?? 0} documents`}>
        <label style={{ display: 'block', border: '1px dashed var(--border-2)', borderRadius: 8, padding: '16px 12px', textAlign: 'center', cursor: 'pointer', marginBottom: 8 }}>
          <input type="file" accept="application/pdf" multiple style={{ display: 'none' }}
            onChange={e => { void uploadFiles(e.target.files); e.target.value = '' }} />
          <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            {uploading ? `Uploading ${uploading}…` : 'Drop / select the data-room lease PDFs (≤20MB each) — stored + extracted automatically'}
          </span>
        </label>
        {(docs.data ?? []).slice(0, 8).map(d => (
          <div key={d.id} style={{ fontSize: 11.5, color: 'var(--text-muted)', padding: '2px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            [{d.doc_type}] {d.title ?? d.file_name}
          </div>
        ))}
        {(docs.data?.length ?? 0) > 8 && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>…and {(docs.data!.length - 8)} more</div>}
      </Widget>

      <Widget title="Tenant abstracts" chip={`${abstracts.data?.length ?? 0}`}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <input value={tenant} onChange={e => setTenant(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void abstractTenant(tenant) }}
            placeholder="Tenant name as it appears in the file names — e.g. Old Navy"
            style={{ flex: 1, fontSize: 12, padding: '7px 10px', borderRadius: 6, background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border-2)' }} />
          <button onClick={() => void abstractTenant(tenant)} disabled={!!working || tenant.trim().length < 3}
            style={{ fontSize: 12, fontWeight: 600, padding: '7px 16px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer' }}>
            {working ? `Abstracting ${working}… (2-4 min)` : 'Abstract + verify'}
          </button>
        </div>
        {err && <div style={{ fontSize: 11.5, color: 'var(--red)', marginBottom: 8 }}>{err}</div>}
        {(abstracts.data ?? []).map(a => (
          <div key={a.id} onClick={() => setOpenTenant(openTenant === a.tenant_name ? null : a.tenant_name)}
            style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
              background: openTenant === a.tenant_name ? 'var(--accent-dim)' : 'transparent' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{a.tenant_name}</span>
            <span style={{ fontSize: 10.5, color: a.qa_status === 'issues' ? 'var(--red, #ef4444)' : a.qa_status === 'review' ? 'var(--amber)' : 'var(--green, #22c55e)' }}>
              {a.qa_status ?? 'unverified'}
            </span>
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)', marginLeft: 'auto' }}>{openTenant === a.tenant_name ? '▾ close' : '▸ open'}</span>
          </div>
        ))}
        {!(abstracts.data ?? []).length && <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Upload the leases above, then abstract each tenant by name.</div>}
      </Widget>

      {openRow && (
        <AbstractView row={openRow as any}
          onRegenerate={() => void abstractTenant(openRow.tenant_name)} busy={working === openRow.tenant_name}
          onVerify={() => { void (async () => { setWorking(openRow.tenant_name); try { await callFn('abstract-verify', openRow.tenant_name) } catch (e) { setErr(String(e)) } finally { setWorking(null); setBump(b => b + 1) } })() }}
          verifying={working === openRow.tenant_name}
          onSaved={() => setBump(b => b + 1)} reviewerId={reviewerId} />
      )}
    </div>
  )
}
