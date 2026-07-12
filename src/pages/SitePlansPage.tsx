import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../contexts/AuthContext'
import { viewHref } from '../lib/viewer'
import { openPdf, type LoadedPdf } from '../lib/pdfRender'
import {
  useSitePlanProperties, useSitePlans, useSitePlanMap,
  type SuiteRegion, type SuiteStatus,
} from '../hooks/useSitePlans'

const FN_BASE = import.meta.env.VITE_SUPABASE_URL + '/functions/v1'
const usd  = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const sfmt = (n: number) => Math.round(n).toLocaleString('en-US')

// status → [fill, border, label] for the map hotspots + legend.
const STATUS_STYLE: Record<SuiteStatus, { fill: string; border: string; label: string }> = {
  occupied:   { fill: 'rgba(48,164,108,0.22)',  border: '#30a46c', label: 'Occupied' },
  expiring:   { fill: 'rgba(245,159,10,0.24)',  border: '#f59f0a', label: 'Expiring ≤12mo' },
  delinquent: { fill: 'rgba(229,72,77,0.24)',   border: '#e5484d', label: 'Delinquent A/R' },
  vacant:     { fill: 'rgba(140,150,160,0.18)', border: '#8c96a0', label: 'Vacant' },
  unknown:    { fill: 'rgba(70,99,113,0.18)',   border: '#466371', label: 'Unmatched' },
}

// A combined plan repeats each suite across its overview + section pages. Collapse
// to one entry per suite (keyed by suite label, else tenant), preferring the
// instance reconciled to the rent roll so the card still shows live data.
function dedupeRegions(regions: SuiteRegion[]): SuiteRegion[] {
  const seen = new Map<string, SuiteRegion>()
  for (const r of regions) {
    const key = r.suiteLabel
      ? 'S:' + r.suiteLabel.toUpperCase().replace(/[^A-Z0-9]/g, '')
      : r.tenant ? 'T:' + r.tenant.toLowerCase().trim()
      : 'ID:' + r.id
    const ex = seen.get(key)
    if (!ex || (!ex.matched && r.matched)) seen.set(key, r)
  }
  return [...seen.values()]
}

export function SitePlansPage() {
  const { appUser, session } = useAuth()
  const privileged = appUser?.role === 'admin' || appUser?.role === 'asset_manager'

  const [params, setParams] = useSearchParams()
  const { data: spProps } = useSitePlanProperties()

  const [propertyId, setPropertyId] = useState<string | null>(params.get('property'))
  // Default to the first property once the list loads.
  useEffect(() => {
    if (!propertyId && spProps && spProps.length) setPropertyId(spProps[0].id)
  }, [spProps, propertyId])

  const { data: plans } = useSitePlans(propertyId)
  const [planId, setPlanId] = useState<string | null>(null)
  useEffect(() => {
    if (plans && plans.length) setPlanId(cur => (cur && plans.some(p => p.id === cur)) ? cur : plans[0].id)
    else setPlanId(null)
  }, [plans])

  const plan = (plans ?? []).find(p => p.id === planId) ?? null
  const { data: mapData, refetch: refetchMap } = useSitePlanMap(propertyId, planId)
  const regions = mapData?.regions ?? []

  const [page, setPage] = useState(1)
  const [numPages, setNumPages] = useState(1)
  const [pdfReady, setPdfReady] = useState(0)   // bumps each time a plan PDF finishes loading
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const [renderErr, setRenderErr] = useState<string | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [extractMsg, setExtractMsg] = useState<string | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pdfRef = useRef<LoadedPdf | null>(null)

  // Keep the URL shareable.
  useEffect(() => {
    if (propertyId) { params.set('property', propertyId); setParams(params, { replace: true }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId])

  // When the region set changes, default to the page with the most suites matched
  // to THIS property's rent roll. A combined East+West plan otherwise opens on
  // whichever section's page comes first (e.g. KM East landing on the West page).
  useEffect(() => {
    setSelectedId(null)
    const regs = mapData?.regions ?? []
    if (!regs.length) { setPage(1); return }
    const byPage = new Map<number, number>()
    for (const r of regs) if (r.matched) byPage.set(r.page, (byPage.get(r.page) ?? 0) + 1)
    // Default to page 1 (the overview / consolidated sheet) when nothing matches
    // this property's rent roll; otherwise the page with the most matched suites.
    let best = 1; let bestN = 0
    for (const [pg, n] of byPage) if (n > bestN) { bestN = n; best = pg }
    setPage(best)
  }, [planId, mapData?.pages.length, mapData?.matched])

  // Open the selected plan PDF.
  useEffect(() => {
    let alive = true
    pdfRef.current?.destroy(); pdfRef.current = null
    setRenderErr(null); setPdfReady(0)
    if (!plan?.signedUrl) { setNumPages(1); return }
    openPdf(plan.signedUrl)
      .then(pdf => { if (!alive) { pdf.destroy(); return } pdfRef.current = pdf; setNumPages(pdf.numPages); setPdfReady(v => v + 1) })
      .catch(e => { if (alive) setRenderErr(e instanceof Error ? e.message : 'Could not load the site plan PDF') })
    return () => { alive = false }
  }, [plan?.signedUrl])

  // Render the current page once the pdf is loaded (pdfReady) and on page change.
  // Keyed on pdfReady — not numPages/signedUrl — so a single-page plan (where
  // numPages stays 1) still renders after the async load resolves.
  useEffect(() => {
    let alive = true
    const pdf = pdfRef.current
    const canvas = canvasRef.current
    if (!pdf || !canvas || pdfReady === 0) return
    setRendering(true)
    pdf.renderPage(page, canvas, 1600)
      .then(() => { if (alive) setRendering(false) })
      .catch(e => { if (alive) { setRendering(false); setRenderErr(e instanceof Error ? e.message : 'Render failed') } })
    return () => { alive = false }
  }, [page, pdfReady])

  const selected = regions.find(r => r.id === selectedId) ?? null
  // De-duped list for the side panel: a combined plan repeats each suite on the
  // overview page AND its section page, so key by suite label (else tenant) and
  // keep the matched instance so clicking still shows rent-roll data.
  const listRegions = dedupeRegions(regions)

  async function autoMap() {
    if (!propertyId || !planId) return
    setExtracting(true); setExtractMsg(null)
    try {
      const res = await fetch(`${FN_BASE}/siteplan-extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token ?? ''}` },
        body: JSON.stringify({ property_id: propertyId, document_id: planId }),
      })
      const json = await res.json()
      if (!res.ok || json.error) throw new Error(String(json.error ?? res.statusText))
      setExtractMsg(`Read ${json.regions} suites (${json.matched} matched to the rent roll).`)
      refetchMap()
    } catch (e) {
      setExtractMsg(e instanceof Error ? e.message : 'Auto-map failed')
    } finally {
      setExtracting(false)
    }
  }

  return (
    <div style={{ padding: '24px 28px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 4 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)' }}>Site Plans</h1>
        {plan?.signedUrl && (
          <div style={{ display: 'flex', gap: 16 }}>
            <a href={viewHref(plan.signedUrl)} target="_blank" rel="noreferrer"
               style={{ fontSize: 12.5, color: 'var(--accent)', textDecoration: 'none', fontWeight: 650 }}>
              Open full PDF ↗
            </a>
            {/* Download the plan PDF itself (Supabase &download forces attachment). */}
            <a href={`${plan.signedUrl}&download=${encodeURIComponent((plan.fileName ?? 'site-plan').replace(/\.pdf$/i, '') + '.pdf')}`}
               style={{ fontSize: 12.5, color: 'var(--accent)', textDecoration: 'none', fontWeight: 650 }}>
              Download PDF ↓
            </a>
          </div>
        )}
      </div>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
        The current site plan, with a live tenant directory — click a suite in the list for its tenant, term, and balance.
      </p>

      {/* Controls */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 14 }}>
        <Select label="Property" value={propertyId ?? ''} onChange={v => { setPropertyId(v); setPlanId(null) }}
                options={(spProps ?? []).map(p => ({ value: p.id, label: p.name }))} />
        {plans && plans.length > 1 && (
          <Select label="Plan" value={planId ?? ''} onChange={setPlanId}
                  options={plans.map(p => ({ value: p.id, label: (p.isPrimary ? '★ ' : '') + (p.fileName ?? p.title ?? p.id).replace(/\.pdf$/i, '') }))} />
        )}
        {numPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1} style={pageBtn(page <= 1)}>‹</button>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Page {page} / {numPages}</span>
            <button onClick={() => setPage(p => Math.min(numPages, p + 1))} disabled={page >= numPages} style={pageBtn(page >= numPages)}>›</button>
          </div>
        )}
        {privileged && plan && (
          <button onClick={autoMap} disabled={extracting} style={{
            marginLeft: 'auto', fontSize: 12, fontWeight: 600,
            color: extracting ? 'var(--text-muted)' : '#fff', background: extracting ? 'var(--surface-2)' : 'var(--accent)',
            border: 'none', borderRadius: 8, padding: '7px 14px', cursor: extracting ? 'default' : 'pointer',
          }}>
            {extracting ? 'Reading suites…' : regions.length ? 'Refresh directory' : 'Build directory'}
          </button>
        )}
      </div>

      {extractMsg && (
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 12 }}>{extractMsg}</div>
      )}

      {!plan && (
        <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>
          {spProps ? 'No site plan on file for this property.' : 'Loading…'}
        </div>
      )}

      {plan && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 300px', gap: 16, alignItems: 'start' }}>
          {/* Map */}
          <div>
            <div style={{ position: 'relative', width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
              <canvas ref={canvasRef} style={{ width: '100%', height: 'auto', display: 'block' }} />
              {rendering && (
                <div style={{ position: 'absolute', top: 8, left: 8, fontSize: 11, color: 'var(--text-faint)', background: 'var(--surface-2)', padding: '2px 8px', borderRadius: 6 }}>
                  rendering…
                </div>
              )}
            </div>
            {renderErr && <div style={{ fontSize: 12, color: 'var(--red, #e5484d)', marginTop: 8 }}>{renderErr}</div>}

            {/* Legend for the directory status dots */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 10, fontSize: 11.5, color: 'var(--text-muted)' }}>
              {(Object.keys(STATUS_STYLE) as SuiteStatus[]).map(s => (
                <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 11, height: 11, borderRadius: 3, background: STATUS_STYLE[s].fill, border: `1.5px solid ${STATUS_STYLE[s].border}` }} />
                  {STATUS_STYLE[s].label}
                </span>
              ))}
            </div>
            {regions.length === 0 && !renderErr && (
              <div style={{ fontSize: 12.5, color: 'var(--text-faint)', marginTop: 10 }}>
                No tenant directory built for this plan yet.{privileged ? ' Use “Build directory” to read the suites off the plan.' : ' An asset manager can build the directory.'}
              </div>
            )}
          </div>

          {/* Side panel */}
          <div style={{ position: 'sticky', top: 12 }}>
            {selected ? (
              <SuiteCard region={selected} />
            ) : (
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 8 }}>
                  {regions.length ? 'Tenant directory — click a suite for details.' : 'Select a plan to begin.'}
                </div>
                {mapData && regions.length > 0 && (
                  <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
                    {listRegions.length} suites · {mapData.matched} matched to the current rent roll
                  </div>
                )}
                {/* Suite list — always usable even if the plan didn't render */}
                {regions.length > 0 && (
                  <div style={{ marginTop: 10, maxHeight: 420, overflowY: 'auto' }}>
                    {listRegions.sort((a, b) => (a.suiteLabel ?? '').localeCompare(b.suiteLabel ?? '')).map(r => (
                      <button key={r.id} onClick={() => { setSelectedId(r.id); setPage(r.page) }}
                        style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 8, textAlign: 'left',
                          padding: '5px 6px', border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          <span style={{ width: 8, height: 8, borderRadius: 2, background: STATUS_STYLE[r.status].border, flexShrink: 0 }} />
                          <span style={{ fontSize: 11.5, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.suiteLabel ? `${r.suiteLabel} · ` : ''}{r.tenant ?? '—'}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SuiteCard({ region: r }: { region: SuiteRegion }) {
  const st = STATUS_STYLE[r.status]
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: st.border, background: st.fill, padding: '2px 8px', borderRadius: 99 }}>{st.label}</span>
        {r.suiteLabel && <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Suite {r.suiteLabel}</span>}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>{r.tenant ?? 'Vacant / unlabelled'}</div>
      <Row k="Size" v={r.sqft != null ? `${sfmt(r.sqft)} SF` : '—'} />
      <Row k="Annual rent" v={r.annualRent != null && r.annualRent > 0 ? usd(r.annualRent) : '—'} />
      <Row k="Lease end" v={r.leaseEnd ?? '—'} />
      <Row k="Open A/R" v={r.arTotal != null ? usd(r.arTotal) : '—'}
           danger={r.arTotal != null && r.arTotal > 0} />
      {(r.rea || r.hasExclusive || r.hasCoTenancy) && (
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--border)', display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {r.rea && <Tag text={`REA: ${r.rea.name}${r.rea.tract ? ` (${r.rea.tract})` : ''}`} />}
          {r.hasExclusive && <Tag text="Exclusive use" />}
          {r.hasCoTenancy && <Tag text="Co-tenancy" />}
        </div>
      )}
    </div>
  )
}

function Row({ k, v, danger }: { k: string; v: string; danger?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 12 }}>
      <span style={{ color: 'var(--text-faint)' }}>{k}</span>
      <span style={{ color: danger ? 'var(--red, #e5484d)' : 'var(--text)', fontWeight: 600 }}>{v}</span>
    </div>
  )
}

function Tag({ text }: { text: string }) {
  return <span style={{ fontSize: 10.5, color: '#7c5cbf', background: 'rgba(147,112,219,0.14)', padding: '2px 8px', borderRadius: 99 }}>{text}</span>
}

function Select({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }>
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
      <span>{label}</span>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 8, color: 'var(--text)', fontSize: 12.5, padding: '6px 10px', maxWidth: 320 }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}

function pageBtn(disabled: boolean): CSSProperties {
  return {
    background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 6,
    color: disabled ? 'var(--text-faint)' : 'var(--text)', fontSize: 14, lineHeight: 1,
    padding: '4px 10px', cursor: disabled ? 'default' : 'pointer',
  }
}
