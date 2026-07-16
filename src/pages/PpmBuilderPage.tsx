// /ppm — PPM (Private Placement Memorandum) generator.
//
// Workflow: create a draft (optionally prefilled from a pipeline deal) ->
// complete the DATA SHEET (paste source-doc text to auto-extract fields) ->
// generate + edit the AI narrative sections (every $ / % / multiple is checked
// against the data sheet) -> export the Word package (main PPM, Offering Page,
// Risk Factors) and finish in Word like every prior deal.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import {
  createPpmDraft, dataSheetFromDeal, deletePpmDraft, draftPpmSection,
  extractPpmFields, savePpmDraft, usePpmDrafts,
  type PpmDraft, type PpmSectionState,
} from '../hooks/usePpmDrafts'
import {
  PPM_SECTIONS, blankDataSheet, verifyNumbers,
  type PpmDataSheet,
} from '../lib/ppm/template'
import { useQuery } from '../hooks/useQuery'

const WILKOW = '#466371'
const WILKOW_MIST = '#8fa2ad'
const SERIF = "'Frank Ruhl Libre', 'Cinzel', Georgia, serif"

// ── field primitives ─────────────────────────────────────────────────────────

const labelStyle: CSSProperties = { display: 'block', fontSize: 11, fontWeight: 600, color: WILKOW, letterSpacing: 0.3, marginBottom: 4 }
const inputStyle: CSSProperties = {
  width: '100%', padding: '8px 10px', fontSize: 13, borderRadius: 7,
  border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text)',
  boxSizing: 'border-box',
}
const btn: CSSProperties = {
  padding: '8px 14px', fontSize: 12.5, fontWeight: 600, borderRadius: 8, cursor: 'pointer',
  border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text)',
}
const btnPrimary: CSSProperties = { ...btn, background: WILKOW, borderColor: WILKOW, color: '#fff' }

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

function Card({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ border: '1px solid var(--border-2)', borderRadius: 12, background: 'var(--surface)', padding: 18, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 12, letterSpacing: 1.4, textTransform: 'uppercase', color: WILKOW_MIST, fontWeight: 700 }}>{title}</h3>
        {right}
      </div>
      {children}
    </section>
  )
}

// ── schema-driven scalar fields ──────────────────────────────────────────────
// kind: text | area | money | num | pct (entered as 7.98, stored as 0.0798)

type Kind = 'text' | 'area' | 'money' | 'num' | 'pct'
interface FieldDef { key: keyof PpmDataSheet & string; label: string; kind: Kind; hint?: string }

const FIELD_GROUPS: { title: string; fields: FieldDef[] }[] = [
  { title: 'Identity', fields: [
    { key: 'propertyName', label: 'Property name', kind: 'text' },
    { key: 'address', label: 'Street address', kind: 'text' },
    { key: 'city', label: 'City', kind: 'text' },
    { key: 'state', label: 'State (full name)', kind: 'text' },
    { key: 'msa', label: 'MSA / market', kind: 'text' },
    { key: 'propertyType', label: 'Property type / risk profile', kind: 'text', hint: 'e.g. Grocery-Anchored Power Center - Core Plus' },
    { key: 'ppmDate', label: 'PPM date', kind: 'text', hint: 'e.g. January 21, 2024' },
  ]},
  { title: 'Physical', fields: [
    { key: 'glaSf', label: 'GLA (SF)', kind: 'num' },
    { key: 'landAcres', label: 'Land (acres)', kind: 'num' },
    { key: 'yearBuilt', label: 'Year built / renovated', kind: 'text' },
    { key: 'occupancyPct', label: 'Occupancy %', kind: 'pct' },
    { key: 'parkingSpaces', label: 'Parking spaces', kind: 'num' },
    { key: 'parkingRatio', label: 'Parking ratio', kind: 'text', hint: '5.42 per 1,000 SF' },
  ]},
  { title: 'Deal terms', fields: [
    { key: 'purchasePrice', label: 'Purchase price', kind: 'money' },
    { key: 'pricePsf', label: 'Price PSF', kind: 'num' },
    { key: 'goingInCap', label: 'Going-in cap %', kind: 'pct' },
    { key: 'inPlaceNoi', label: 'In-place NOI', kind: 'money' },
    { key: 'totalCapitalization', label: 'Total capitalization', kind: 'money' },
  ]},
  { title: 'Joint venture', fields: [
    { key: 'jvPartnerName', label: 'JV partner (legal name)', kind: 'text' },
    { key: 'jvPartnerShort', label: 'JV partner (short name)', kind: 'text' },
    { key: 'jvPartnerPct', label: 'Partner ownership %', kind: 'pct' },
    { key: 'mjwPct', label: 'MJW ownership %', kind: 'pct' },
    { key: 'jvPartnerBlurb', label: 'Partner credibility paragraph', kind: 'area' },
    { key: 'jvHistoryNote', label: 'JV history note', kind: 'area', hint: 'e.g. fifth JV between MJW and MetLife' },
    { key: 'jvVehicleName', label: 'JV entity (Operating Company) name', kind: 'text' },
    { key: 'propertyOwnerLlc', label: 'Property-owner LLC name', kind: 'text' },
  ]},
  { title: 'Equity stack', fields: [
    { key: 'totalEquity', label: 'Total equity requirement', kind: 'money' },
    { key: 'partnerEquity', label: 'Partner equity', kind: 'money' },
    { key: 'mjwEquity', label: 'MJW investor-company equity', kind: 'money' },
    { key: 'sponsorFee', label: 'Sponsor fee', kind: 'money' },
    { key: 'workingCapital', label: 'Working capital', kind: 'money' },
    { key: 'investorCompanyTotal', label: 'Investor company total raise', kind: 'money' },
  ]},
  { title: 'Wilkow Investor Company', fields: [
    { key: 'investorCompanyName', label: 'Investor company name', kind: 'text', hint: 'M & J ____ Investors LLC' },
    { key: 'managerIncName', label: 'Manager Inc. name', kind: 'text', hint: 'M & J ____ Manager Inc.' },
    { key: 'managerStockholders', label: 'Manager stockholders', kind: 'text' },
    { key: 'classAUnits', label: 'Class A units', kind: 'num' },
    { key: 'classAUnitPrice', label: 'Class A unit price', kind: 'money' },
    { key: 'classBUnits', label: 'Class B units', kind: 'num' },
    { key: 'classBUnitPrice', label: 'Class B unit price', kind: 'money' },
    { key: 'minSubscriptionUnits', label: 'Minimum subscription (units)', kind: 'num' },
    { key: 'classAPrefIrr', label: 'Class A pref IRR %', kind: 'pct' },
    { key: 'classAPrefEm', label: 'Class A pref equity multiple', kind: 'num' },
    { key: 'classAExcessPct', label: 'Class A share of excess %', kind: 'pct' },
  ]},
  { title: 'Financing', fields: [
    { key: 'lenderName', label: 'Lender', kind: 'text' },
    { key: 'loanAmount', label: 'Loan amount', kind: 'money' },
    { key: 'ltvPct', label: 'LTV %', kind: 'pct' },
    { key: 'interestRate', label: 'Interest rate %', kind: 'pct' },
    { key: 'rateDescription', label: 'Rate description', kind: 'text', hint: '5.95% Fixed (10 Yr. UST + 205 bps)' },
    { key: 'loanTermYears', label: 'Term (years)', kind: 'num' },
    { key: 'ioDescription', label: 'Interest-only description', kind: 'text' },
    { key: 'futureFunding', label: 'Future funding', kind: 'text' },
  ]},
  { title: 'Forecast (base case)', fields: [
    { key: 'holdYears', label: 'Hold (years)', kind: 'num' },
    { key: 'exitCap', label: 'Exit cap %', kind: 'pct' },
    { key: 'projSalePrice', label: 'Projected sale price', kind: 'money' },
    { key: 'projSalePsf', label: 'Projected sale PSF', kind: 'num' },
    { key: 'projIrr', label: 'Levered IRR %', kind: 'pct' },
    { key: 'avgCoc', label: 'Avg cash-on-cash %', kind: 'pct' },
    { key: 'equityMultiple', label: 'Equity multiple', kind: 'num' },
    { key: 'afterTaxIrr', label: 'After-tax IRR %', kind: 'pct' },
    { key: 'afterTaxCoc', label: 'After-tax CoC %', kind: 'pct' },
    { key: 'occupancyAtExit', label: 'Occupancy at exit %', kind: 'pct' },
  ]},
  { title: 'Operating assumptions', fields: [
    { key: 'opexPsfYr1', label: 'OpEx PSF (Yr 1)', kind: 'num' },
    { key: 'opexGrowthNote', label: 'OpEx growth note', kind: 'text' },
    { key: 'retPsfYr1', label: 'RE taxes PSF (Yr 1)', kind: 'num' },
    { key: 'retNote', label: 'RE tax / reassessment note', kind: 'area' },
    { key: 'mgmtFeePct', label: 'Management fee %', kind: 'pct' },
    { key: 'capexBudgetTotal', label: 'CapEx budget total', kind: 'money' },
    { key: 'structuralReservePsf', label: 'Structural reserve PSF', kind: 'num' },
    { key: 'auditReserveAnnual', label: 'Audit/leasing/legal reserve ($/yr)', kind: 'money' },
    { key: 'leasingAssumptionsNote', label: 'Market leasing assumptions note', kind: 'area' },
  ]},
  { title: 'Tax section', fields: [
    { key: 'landBldgSplit', label: 'Land/building split', kind: 'text', hint: '20%/80%' },
    { key: 'loanFeesAcqCosts', label: 'Loan fees / acquisition costs', kind: 'money' },
    { key: 'stateTaxRate', label: 'State tax rate %', kind: 'pct' },
    { key: 'stateTaxName', label: 'State (for tax rates)', kind: 'text' },
  ]},
  { title: 'PCA / Environmental', fields: [
    { key: 'pcaFirm', label: 'PCA firm', kind: 'text' },
    { key: 'pcaDate', label: 'PCA date', kind: 'text' },
    { key: 'pcaImmediateRepairs', label: 'Immediate repairs $', kind: 'money' },
    { key: 'pcaReserve12yr', label: '12-yr reserve $', kind: 'money' },
    { key: 'pcaPsfPerYear', label: 'Reserve $/sf/yr', kind: 'num' },
    { key: 'pcaKeyItems', label: 'Key capital items', kind: 'area' },
    { key: 'esaFirm', label: 'Phase I firm', kind: 'text' },
    { key: 'esaDate', label: 'Phase I date', kind: 'text' },
    { key: 'esaFindings', label: 'Phase I findings', kind: 'area', hint: 'continue the sentence "the Phase I ESA for <Property> ..."' },
  ]},
  { title: 'Property details', fields: [
    { key: 'taxParcels', label: 'Tax parcel IDs', kind: 'area' },
    { key: 'zoningText', label: 'Zoning', kind: 'area' },
    { key: 'accessText', label: 'Access', kind: 'area' },
    { key: 'signageText', label: 'Signage', kind: 'area' },
    { key: 'siteImprovementsText', label: 'Site improvements', kind: 'area' },
    { key: 'foundationText', label: 'Foundation / substructure', kind: 'area' },
    { key: 'facadeText', label: 'Facade', kind: 'area' },
    { key: 'roofsText', label: 'Roofs', kind: 'area' },
    { key: 'utilitiesText', label: 'Utilities', kind: 'area' },
    { key: 'floodZoneText', label: 'Flood zone', kind: 'area' },
  ]},
  { title: 'Market', fields: [
    { key: 'submarketName', label: 'Submarket', kind: 'text' },
    { key: 'marketVacancy', label: 'Market vacancy %', kind: 'pct' },
    { key: 'submarketVacancy', label: 'Submarket vacancy %', kind: 'pct' },
    { key: 'pop3mi', label: 'Population (3 mi)', kind: 'num' },
    { key: 'pop5mi', label: 'Population (5 mi)', kind: 'num' },
    { key: 'hhi3mi', label: 'Avg HH income (3 mi)', kind: 'money' },
    { key: 'trafficCounts', label: 'Traffic counts', kind: 'text' },
    { key: 'marketOverviewNotes', label: 'Market overview notes (for AI)', kind: 'area' },
    { key: 'salesCompsNote', label: 'Sales comps note', kind: 'area' },
    { key: 'leaseCompsNote', label: 'Lease comps note', kind: 'area' },
    { key: 'competingCentersNote', label: 'Competing centers note', kind: 'area' },
    { key: 'anchorStory', label: 'Tenancy / anchor story notes (for AI)', kind: 'area' },
  ]},
  { title: 'Subscription mechanics', fields: [
    { key: 'subscriptionDeadline', label: 'Subscription deadline', kind: 'text' },
    { key: 'wireBeneficiary', label: 'Wire beneficiary', kind: 'text' },
    { key: 'wireAccountNo', label: 'Account no.', kind: 'text' },
    { key: 'wireBankName', label: 'Bank name', kind: 'text' },
    { key: 'wireBankAddress', label: 'Bank address', kind: 'text' },
    { key: 'wireRoutingNo', label: 'Wire routing no.', kind: 'text' },
    { key: 'achRoutingNo', label: 'ACH routing no.', kind: 'text' },
    { key: 'swiftCode', label: 'SWIFT code', kind: 'text' },
  ]},
]

function ScalarField({ def, ds, set }: { def: FieldDef; ds: PpmDataSheet; set: (k: string, v: unknown) => void }) {
  const raw = ds[def.key] as unknown
  if (def.kind === 'area') {
    return (
      <div style={{ gridColumn: '1 / -1' }}>
        <label style={labelStyle}>{def.label}{def.hint ? <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}> · {def.hint}</span> : null}</label>
        <textarea style={{ ...inputStyle, minHeight: 54, resize: 'vertical' }} value={String(raw ?? '')} onChange={e => set(def.key, e.target.value)} />
      </div>
    )
  }
  let display = ''
  if (def.kind === 'text') display = String(raw ?? '')
  else if (raw != null && raw !== '') display = def.kind === 'pct' ? String(+((raw as number) * 100).toFixed(4)) : String(raw)
  const parse = (v: string): unknown => {
    if (def.kind === 'text') return v
    if (v.trim() === '') return null
    const n = Number(v.replace(/[$,%\s]/g, '').replace(/,/g, ''))
    if (!isFinite(n)) return null
    return def.kind === 'pct' ? n / 100 : n
  }
  return (
    <div>
      <label style={labelStyle}>{def.label}{def.hint ? <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}> · {def.hint}</span> : null}</label>
      <input style={inputStyle} value={display} placeholder={def.kind === 'pct' ? 'e.g. 7.98' : undefined}
        onChange={e => set(def.key, parse(e.target.value))} />
    </div>
  )
}

// ── generic row-list editor (tenants, budgets, tiers, ...) ───────────────────

interface Col { key: string; label: string; kind?: 'num' | 'pct' | 'bool'; width?: number }

function ListEditor({ title, rows, cols, onChange, blank }: {
  title: string
  rows: Record<string, unknown>[]
  cols: Col[]
  onChange: (rows: Record<string, unknown>[]) => void
  blank: Record<string, unknown>
}) {
  const setCell = (i: number, key: string, v: unknown) => {
    const next = rows.map((r, j) => (j === i ? { ...r, [key]: v } : r))
    onChange(next)
  }
  return (
    <Card title={title} right={<button style={btn} onClick={() => onChange([...rows, { ...blank }])}>+ Add</button>}>
      {rows.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>No rows yet.</div>}
      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                {cols.map(c => <th key={c.key} style={{ textAlign: 'left', fontSize: 10.5, color: WILKOW_MIST, padding: '2px 6px', whiteSpace: 'nowrap' }}>{c.label}</th>)}
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {cols.map(c => (
                    <td key={c.key} style={{ padding: 2, minWidth: c.width ?? 90 }}>
                      {c.kind === 'bool' ? (
                        <input type="checkbox" checked={Boolean(r[c.key])} onChange={e => setCell(i, c.key, e.target.checked)} />
                      ) : (
                        <input
                          style={{ ...inputStyle, padding: '5px 7px', fontSize: 12 }}
                          value={r[c.key] == null ? '' : c.kind === 'pct' ? String(+((r[c.key] as number) * 100).toFixed(4)) : String(r[c.key])}
                          onChange={e => {
                            const v = e.target.value
                            if (!c.kind) setCell(i, c.key, v)
                            else if (v.trim() === '') setCell(i, c.key, null)
                            else {
                              const n = Number(v.replace(/[$,%\s]/g, ''))
                              setCell(i, c.key, isFinite(n) ? (c.kind === 'pct' ? n / 100 : n) : null)
                            }
                          }}
                        />
                      )}
                    </td>
                  ))}
                  <td><button style={{ ...btn, padding: '4px 8px' }} title="Remove row" onClick={() => onChange(rows.filter((_, j) => j !== i))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

// ── minimal pipeline-deal picker (avoid pulling the whole usePipeline hook) ──

function useDealOptions() {
  return useQuery<{ id: string; label: string }[]>(async () => {
    const { data, error } = await supabase
      .from('pipeline_deals')
      .select('id, name, city, state, stage')
      .not('stage', 'in', '(passed,dead,lost)')
      .order('name')
    if (error) return []
    return (data ?? []).map(d => ({ id: d.id, label: `${d.name}${d.city ? ` - ${d.city}, ${d.state}` : ''}` }))
  }, [])
}

// ── main page ────────────────────────────────────────────────────────────────

export function PpmBuilderPage() {
  const drafts = usePpmDrafts()
  const deals = useDealOptions()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [local, setLocal] = useState<PpmDraft | null>(null)
  const [tab, setTab] = useState<'data' | 'sections' | 'export'>('data')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const dirtyRef = useRef(false)

  // New-draft composer
  const [composerOpen, setComposerOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDealId, setNewDealId] = useState('')

  const selected = useMemo(
    () => drafts.data?.find(d => d.id === selectedId) ?? null,
    [drafts.data, selectedId],
  )

  // Adopt a fresh local copy whenever the selection changes.
  useEffect(() => {
    setLocal(selected ? JSON.parse(JSON.stringify(selected)) : null)
    dirtyRef.current = false
  }, [selectedId, selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced autosave of data_sheet + sections.
  useEffect(() => {
    if (!local || !dirtyRef.current) return
    const t = setTimeout(async () => {
      try {
        setSaving(true)
        await savePpmDraft(local.id, { name: local.name, data_sheet: local.data_sheet, sections: local.sections, status: local.status })
        dirtyRef.current = false
      } catch (e) {
        setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Save failed' })
      } finally {
        setSaving(false)
      }
    }, 1200)
    return () => clearTimeout(t)
  }, [local])

  const mutate = (fn: (d: PpmDraft) => void) => {
    setLocal(prev => {
      if (!prev) return prev
      const next = { ...prev, data_sheet: { ...prev.data_sheet }, sections: { ...prev.sections } }
      fn(next)
      dirtyRef.current = true
      return next
    })
  }
  const setField = (k: string, v: unknown) => mutate(d => { (d.data_sheet as unknown as Record<string, unknown>)[k] = v })

  async function handleCreate() {
    try {
      let ds = blankDataSheet()
      let name = newName.trim()
      if (newDealId) {
        const pre = await dataSheetFromDeal(newDealId)
        ds = pre.ds
        if (!name) name = pre.name
      }
      if (!name) { setMsg({ kind: 'err', text: 'Give the PPM a name (or pick a deal).' }); return }
      const { data: auth } = await supabase.auth.getUser()
      const created = await createPpmDraft(name, newDealId || null, ds, auth.user?.id ?? null)
      setComposerOpen(false); setNewName(''); setNewDealId('')
      drafts.refetch()
      setSelectedId(created.id)
      setTab('data')
      setMsg({ kind: 'ok', text: newDealId ? 'Draft created and prefilled from the pipeline deal.' : 'Draft created.' })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Create failed' })
    }
  }

  return (
    <div style={{ padding: '26px 30px', maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 2.4, color: WILKOW_MIST, fontWeight: 700 }}>PRIVATE PLACEMENTS</div>
          <h1 style={{ margin: '4px 0 0', fontFamily: SERIF, fontSize: 28, fontWeight: 600 }}>PPM Generator</h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {saving && <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>Saving…</span>}
          <button style={btnPrimary} onClick={() => setComposerOpen(o => !o)}>+ New PPM</button>
        </div>
      </div>

      {msg && (
        <div
          onClick={() => setMsg(null)}
          style={{
            marginBottom: 14, padding: '9px 13px', borderRadius: 8, fontSize: 12.5, cursor: 'pointer',
            background: msg.kind === 'ok' ? 'rgba(70,140,90,.12)' : 'rgba(190,60,60,.12)',
            color: msg.kind === 'ok' ? '#2e7d4f' : '#b03636',
            border: `1px solid ${msg.kind === 'ok' ? 'rgba(70,140,90,.35)' : 'rgba(190,60,60,.35)'}`,
          }}
        >{msg.text}</div>
      )}

      {composerOpen && (
        <Card title="New PPM draft">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, alignItems: 'end' }}>
            <div>
              <label style={labelStyle}>PPM name</label>
              <input style={inputStyle} value={newName} placeholder="e.g. Silverado Ranch Plaza" onChange={e => setNewName(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Prefill from pipeline deal (optional)</label>
              <select style={inputStyle} value={newDealId} onChange={e => setNewDealId(e.target.value)}>
                <option value="">— none —</option>
                {(deals.data ?? []).map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
            </div>
            <button style={btnPrimary} onClick={handleCreate}>Create</button>
          </div>
        </Card>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 18 }}>
        {/* draft list */}
        <div>
          <Card title="Drafts">
            {drafts.loading && <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>Loading…</div>}
            {!drafts.loading && !(drafts.data ?? []).length && (
              <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>
                No PPM drafts yet. Click "+ New PPM" — optionally prefilled from a pipeline deal.
              </div>
            )}
            {(drafts.data ?? []).map(d => (
              <div
                key={d.id}
                onClick={() => setSelectedId(d.id)}
                style={{
                  padding: '9px 11px', borderRadius: 8, cursor: 'pointer', marginBottom: 6,
                  border: `1px solid ${d.id === selectedId ? WILKOW : 'var(--border-2)'}`,
                  background: d.id === selectedId ? 'rgba(70,99,113,.08)' : 'transparent',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600 }}>{d.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                  {d.status} · {new Date(d.updated_at).toLocaleDateString()}
                </div>
              </div>
            ))}
          </Card>
        </div>

        {/* editor */}
        <div>
          {!local && (
            <Card title="Getting started">
              <div style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--text)' }}>
                <p style={{ marginTop: 0 }}>Select or create a draft. The workflow:</p>
                <ol style={{ paddingLeft: 18, margin: 0 }}>
                  <li><b>Data sheet</b> — every deal fact in one place. Paste text from DD documents (rent roll, PCA, loan/JV term sheets, market reports) to auto-extract fields.</li>
                  <li><b>Sections</b> — generate the narrative sections in the house voice; boilerplate sections fill themselves from the data sheet. Every $ / % / multiple in an AI draft is checked against the data sheet.</li>
                  <li><b>Export</b> — download the Word package (main PPM, Offering Page, Risk Factors) and finish in Word.</li>
                </ol>
              </div>
            </Card>
          )}

          {local && (
            <>
              <div style={{ display: 'flex', gap: 6, marginBottom: 14, alignItems: 'center' }}>
                {(['data', 'sections', 'export'] as const).map(t => (
                  <button key={t} style={tab === t ? btnPrimary : btn} onClick={() => setTab(t)}>
                    {t === 'data' ? 'Data sheet' : t === 'sections' ? 'Sections' : 'Export'}
                  </button>
                ))}
                <div style={{ flex: 1 }} />
                <select
                  style={{ ...inputStyle, width: 120 }}
                  value={local.status}
                  onChange={e => mutate(d => { d.status = e.target.value as PpmDraft['status'] })}
                >
                  <option value="draft">draft</option>
                  <option value="review">review</option>
                  <option value="final">final</option>
                </select>
                <button
                  style={{ ...btn, color: '#b03636' }}
                  onClick={async () => {
                    if (!confirm(`Delete PPM draft "${local.name}"?`)) return
                    await deletePpmDraft(local.id)
                    setSelectedId(null)
                    drafts.refetch()
                  }}
                >Delete</button>
              </div>

              {tab === 'data' && <DataSheetTab ds={local.data_sheet} setField={setField} mutate={mutate} setMsg={setMsg} />}
              {tab === 'sections' && <SectionsTab draft={local} mutate={mutate} setMsg={setMsg} />}
              {tab === 'export' && <ExportTab draft={local} setMsg={setMsg} />}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Data sheet tab ───────────────────────────────────────────────────────────

function DataSheetTab({ ds, setField, mutate, setMsg }: {
  ds: PpmDataSheet
  setField: (k: string, v: unknown) => void
  mutate: (fn: (d: PpmDraft) => void) => void
  setMsg: (m: { kind: 'ok' | 'err'; text: string } | null) => void
}) {
  const [pasteText, setPasteText] = useState('')
  const [focus, setFocus] = useState('')
  const [extracting, setExtracting] = useState(false)

  async function handleExtract() {
    if (!pasteText.trim()) return
    setExtracting(true)
    try {
      const fields = await extractPpmFields(pasteText, focus)
      let filled = 0
      mutate(d => {
        const t = d.data_sheet as unknown as Record<string, unknown>
        for (const [k, v] of Object.entries(fields)) {
          if (v == null || v === '') continue
          const cur = t[k]
          const isEmpty = cur == null || cur === '' || (Array.isArray(cur) && cur.length === 0)
          if (isEmpty) { t[k] = v; filled++ }
        }
      })
      setMsg({ kind: 'ok', text: `Extracted ${Object.keys(fields).length} field(s); filled ${filled} empty field(s). Pre-filled values were not overwritten.` })
      setPasteText('')
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Extraction failed' })
    } finally {
      setExtracting(false)
    }
  }

  return (
    <>
      <Card title="Paste & extract from a source document"
        right={<button style={btnPrimary} disabled={extracting || !pasteText.trim()} onClick={handleExtract}>{extracting ? 'Extracting…' : 'Extract fields'}</button>}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 10 }}>
          <textarea
            style={{ ...inputStyle, minHeight: 90, resize: 'vertical' }}
            placeholder="Paste text from a rent roll, PCA/Phase I summary, loan term sheet, JV term sheet, tax bill, zoning or market report… Only empty fields get filled."
            value={pasteText} onChange={e => setPasteText(e.target.value)}
          />
          <div>
            <label style={labelStyle}>Document type (optional)</label>
            <select style={inputStyle} value={focus} onChange={e => setFocus(e.target.value)}>
              <option value="">auto-detect</option>
              <option value="rent roll">Rent roll</option>
              <option value="PCA / property condition report">PCA</option>
              <option value="Phase I environmental report">Phase I ESA</option>
              <option value="loan term sheet / application">Loan term sheet</option>
              <option value="JV term sheet / LOI">JV term sheet</option>
              <option value="market or demographic report">Market report</option>
              <option value="co-tenancy and exclusives summary">Co-tenancy summary</option>
              <option value="operating statements / historical NOI">Operating statements</option>
            </select>
          </div>
        </div>
      </Card>

      {FIELD_GROUPS.map(g => (
        <Card key={g.title} title={g.title}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {g.fields.map(f => <ScalarField key={f.key} def={f} ds={ds} set={setField} />)}
          </div>
          {g.title === 'Forecast (base case)' && (
            <div style={{ marginTop: 10 }}>
              <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={ds.hasUpsideCase} onChange={e => setField('hasUpsideCase', e.target.checked)} />
                Include an Upside Case
              </label>
              {ds.hasUpsideCase && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 10 }}>
                  {([
                    { key: 'upsideHoldYears', label: 'Upside hold (years)', kind: 'num' },
                    { key: 'upsideExitCap', label: 'Upside exit cap %', kind: 'pct' },
                    { key: 'upsideSalePrice', label: 'Upside sale price', kind: 'money' },
                    { key: 'upsideIrr', label: 'Upside IRR %', kind: 'pct' },
                    { key: 'upsideCoc', label: 'Upside CoC %', kind: 'pct' },
                    { key: 'upsideEm', label: 'Upside equity multiple', kind: 'num' },
                    { key: 'upsideAfterTaxIrr', label: 'Upside after-tax IRR %', kind: 'pct' },
                    { key: 'upsideAfterTaxCoc', label: 'Upside after-tax CoC %', kind: 'pct' },
                    { key: 'upsideNotes', label: 'Upside case notes (what changes vs base)', kind: 'area' },
                  ] as FieldDef[]).map(f => <ScalarField key={f.key} def={f} ds={ds} set={setField} />)}
                </div>
              )}
            </div>
          )}
        </Card>
      ))}

      <ListEditor
        title="Tenants (roster)"
        rows={ds.tenants as unknown as Record<string, unknown>[]}
        onChange={rows => setField('tenants', rows)}
        blank={{ name: '', sf: null, pctGla: null, pctRev: null, rentPsf: null, leaseType: 'NNN', expiration: '', options: '', salesPsf: null, healthRatio: null, placerRank: '', groundLease: false }}
        cols={[
          { key: 'name', label: 'Tenant', width: 150 }, { key: 'sf', label: 'SF', kind: 'num' },
          { key: 'pctGla', label: '% GLA', kind: 'pct' }, { key: 'pctRev', label: '% Rev', kind: 'pct' },
          { key: 'rentPsf', label: 'Rent PSF', kind: 'num' }, { key: 'leaseType', label: 'Type', width: 60 },
          { key: 'expiration', label: 'Expiration' }, { key: 'options', label: 'Options', width: 110 },
          { key: 'salesPsf', label: 'Sales PSF', kind: 'num' }, { key: 'healthRatio', label: 'Health %', kind: 'pct' },
          { key: 'placerRank', label: 'Placer', width: 100 }, { key: 'groundLease', label: 'GL', kind: 'bool', width: 30 },
        ]}
      />
      <ListEditor
        title="Co-tenancy requirements"
        rows={ds.coTenancy as unknown as Record<string, unknown>[]}
        onChange={rows => setField('coTenancy', rows)}
        blank={{ tenant: '', requirement: '', conclusion: '' }}
        cols={[
          { key: 'tenant', label: 'Tenant', width: 130 },
          { key: 'requirement', label: 'Requirement', width: 320 },
          { key: 'conclusion', label: 'Conclusion', width: 320 },
        ]}
      />
      <ListEditor
        title="Tenant profiles (major tenants)"
        rows={ds.tenantProfiles as unknown as Record<string, unknown>[]}
        onChange={rows => setField('tenantProfiles', rows)}
        blank={{ name: '', sf: null, creditRating: '', expiration: '', blurb: '' }}
        cols={[
          { key: 'name', label: 'Tenant', width: 140 }, { key: 'sf', label: 'SF', kind: 'num' },
          { key: 'creditRating', label: 'Credit', width: 70 }, { key: 'expiration', label: 'Expiration', width: 100 },
          { key: 'blurb', label: 'Company blurb', width: 380 },
        ]}
      />
      <ListEditor
        title="Value-add initiatives"
        rows={ds.valueAddInitiatives as unknown as Record<string, unknown>[]}
        onChange={rows => setField('valueAddInitiatives', rows)}
        blank={{ title: '', body: '' }}
        cols={[{ key: 'title', label: 'Title', width: 200 }, { key: 'body', label: 'Body', width: 480 }]}
      />
      <ListEditor
        title="Acquisition budget line items"
        rows={ds.acquisitionBudget as unknown as Record<string, unknown>[]}
        onChange={rows => setField('acquisitionBudget', rows)}
        blank={{ item: '', amount: null }}
        cols={[{ key: 'item', label: 'Item', width: 280 }, { key: 'amount', label: 'Amount', kind: 'num', width: 140 }]}
      />
      <ListEditor
        title="CapEx budget line items"
        rows={ds.capexBudgetLines as unknown as Record<string, unknown>[]}
        onChange={rows => setField('capexBudgetLines', rows)}
        blank={{ item: '', amount: null }}
        cols={[{ key: 'item', label: 'Item', width: 280 }, { key: 'amount', label: 'Est. cost', kind: 'num', width: 140 }]}
      />
      <ListEditor
        title="JV promote tiers"
        rows={ds.jvWaterfallTiers as unknown as Record<string, unknown>[]}
        onChange={rows => setField('jvWaterfallTiers', rows)}
        blank={{ split: '', until: '' }}
        cols={[
          { key: 'split', label: 'Split (e.g. 82.16% to MetLife and 17.84% to the Wilkow Investor Company)', width: 340 },
          { key: 'until', label: 'Until (e.g. the MetLife Fund shall have received the lesser of a 12.0% IRR or a 3.0x equity multiple)', width: 380 },
        ]}
      />
      <ListEditor
        title="Historical NOI"
        rows={ds.historicalNoi as unknown as Record<string, unknown>[]}
        onChange={rows => setField('historicalNoi', rows)}
        blank={{ year: '', income: null, expenses: null, noi: null }}
        cols={[
          { key: 'year', label: 'Year', width: 80 }, { key: 'income', label: 'Total income', kind: 'num' },
          { key: 'expenses', label: 'Total opex', kind: 'num' }, { key: 'noi', label: 'NOI', kind: 'num' },
        ]}
      />
      <ListEditor
        title="Investor contacts (subscription page)"
        rows={ds.contacts as unknown as Record<string, unknown>[]}
        onChange={rows => setField('contacts', rows)}
        blank={{ name: '', phone: '', email: '' }}
        cols={[{ key: 'name', label: 'Name', width: 160 }, { key: 'phone', label: 'Phone', width: 130 }, { key: 'email', label: 'Email', width: 200 }]}
      />
    </>
  )
}

// ── Sections tab ─────────────────────────────────────────────────────────────

function SectionsTab({ draft, mutate, setMsg }: {
  draft: PpmDraft
  mutate: (fn: (d: PpmDraft) => void) => void
  setMsg: (m: { kind: 'ok' | 'err'; text: string } | null) => void
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)

  const aiSections = PPM_SECTIONS.filter(s => s.mode === 'ai')

  async function draftOne(key: string) {
    const text = await draftPpmSection(key, draft.data_sheet, notes[key])
    mutate(d => {
      d.sections[key] = { text, mode: 'ai', generated_at: new Date().toISOString(), approved: false }
    })
  }

  async function generate(key: string) {
    setBusyKey(key)
    try {
      await draftOne(key)
      setMsg({ kind: 'ok', text: 'Section drafted — review the numbers flagged below, edit freely, then mark approved.' })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Draft failed' })
    } finally {
      setBusyKey(null)
    }
  }

  // Generate every AI section that has no text yet — never touches drafts you've
  // already generated or edited. Runs sequentially so progress is visible and
  // the API isn't hammered.
  async function generateAll() {
    const pending = aiSections.filter(s => !draft.sections[s.key]?.text)
    if (!pending.length) {
      setMsg({ kind: 'ok', text: 'Every section already has a draft. Use a section Regenerate button to redo one.' })
      return
    }
    if (!confirm(`Draft ${pending.length} empty section(s) from the current data sheet? This calls the AI ${pending.length} time(s).`)) return
    setBatch({ done: 0, total: pending.length })
    let ok = 0
    for (const s of pending) {
      setBusyKey(s.key)
      try { await draftOne(s.key); ok++ } catch { /* keep going; per-section errors surface on retry */ }
      setBatch(b => (b ? { ...b, done: b.done + 1 } : b))
    }
    setBusyKey(null)
    setBatch(null)
    setMsg({
      kind: ok === pending.length ? 'ok' : 'err',
      text: ok === pending.length
        ? `Drafted ${ok} section(s). Review the flagged figures, edit, and mark each approved.`
        : `Drafted ${ok} of ${pending.length}. Retry any that failed with its Generate button.`,
    })
  }

  const draftedCount = aiSections.filter(s => draft.sections[s.key]?.text).length

  return (
    <>
      <Card
        title="Narrative sections"
        right={
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
              {batch ? `Drafting ${batch.done}/${batch.total}…` : `${draftedCount}/${aiSections.length} drafted`}
            </span>
            <button style={btnPrimary} disabled={busyKey !== null || batch !== null} onClick={generateAll}>
              {batch ? 'Generating…' : 'Generate all sections'}
            </button>
          </div>
        }
      >
        <div style={{ fontSize: 12.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
          "Generate all sections" drafts every section that's still empty from the current data sheet — it won't overwrite drafts you've already generated or edited. Template sections below fill automatically and need no generation.
        </div>
      </Card>

      {PPM_SECTIONS.map(def => {
        const st: PpmSectionState | undefined = draft.sections[def.key]
        if (def.mode === 'template') {
          const rendered = def.render ? def.render(draft.data_sheet) : ''
          return (
            <Card key={def.key} title={`${def.title} · auto-generated`}>
              <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', color: 'var(--text-2)', maxHeight: 260, overflowY: 'auto', lineHeight: 1.55 }}>
                {rendered || '(fills from the data sheet)'}
              </div>
            </Card>
          )
        }
        const checks = st?.text ? verifyNumbers(st.text, draft.data_sheet) : []
        const bad = checks.filter(c => !c.ok)
        return (
          <Card
            key={def.key}
            title={def.title}
            right={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {st?.text && (
                  <label style={{ fontSize: 12, display: 'flex', gap: 5, alignItems: 'center', color: st.approved ? '#2e7d4f' : 'var(--text-faint)' }}>
                    <input
                      type="checkbox"
                      checked={Boolean(st.approved)}
                      onChange={e => mutate(d => { d.sections[def.key] = { ...d.sections[def.key], approved: e.target.checked } })}
                    />
                    Approved
                  </label>
                )}
                <button style={btnPrimary} disabled={busyKey !== null} onClick={() => generate(def.key)}>
                  {busyKey === def.key ? 'Drafting…' : st?.text ? 'Regenerate' : 'Generate'}
                </button>
              </div>
            }
          >
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 8 }}>{def.hint}</div>
            <input
              style={{ ...inputStyle, marginBottom: 8 }}
              placeholder="Optional notes to steer this draft (e.g. emphasize the Whole Foods expansion)…"
              value={notes[def.key] ?? ''}
              onChange={e => setNotes(n => ({ ...n, [def.key]: e.target.value }))}
            />
            {st?.text ? (
              <>
                <textarea
                  style={{ ...inputStyle, minHeight: 220, resize: 'vertical', lineHeight: 1.55, fontSize: 13 }}
                  value={st.text}
                  onChange={e => mutate(d => { d.sections[def.key] = { ...d.sections[def.key], text: e.target.value, mode: 'edited', approved: false } })}
                />
                {checks.length > 0 && (
                  <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {bad.length === 0
                      ? <span style={{ fontSize: 11.5, color: '#2e7d4f' }}>✓ All {checks.length} figures tie to the data sheet</span>
                      : bad.map(c => (
                        <span key={c.token} title="This figure does not appear anywhere on the data sheet — verify or correct it."
                          style={{ fontSize: 11.5, padding: '2px 8px', borderRadius: 20, background: 'rgba(190,60,60,.12)', color: '#b03636', border: '1px solid rgba(190,60,60,.35)' }}>
                          ⚠ {c.token}
                        </span>
                      ))}
                  </div>
                )}
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>Not drafted yet.</div>
            )}
          </Card>
        )
      })}
    </>
  )
}

// ── Export tab ───────────────────────────────────────────────────────────────

function ExportTab({ draft, setMsg }: {
  draft: PpmDraft
  setMsg: (m: { kind: 'ok' | 'err'; text: string } | null) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const aiSections = PPM_SECTIONS.filter(s => s.mode === 'ai')
  const drafted = aiSections.filter(s => draft.sections[s.key]?.text)
  const approved = drafted.filter(s => draft.sections[s.key]?.approved)
  const safeName = (draft.data_sheet.propertyName || draft.name).replace(/[^\w\- ]+/g, '').trim() || 'PPM'

  async function exportDoc(kind: 'ppm' | 'offering' | 'risks') {
    setBusy(kind)
    try {
      const mod = await import('../reports/ppm/renderDocx')
      if (kind === 'ppm') download(await mod.buildPpmDocx(draft.data_sheet, draft.sections), `${safeName} - PPM DRAFT.docx`)
      if (kind === 'offering') download(await mod.buildOfferingPageDocx(draft.data_sheet), `${safeName} - Offering Page.docx`)
      if (kind === 'risks') download(await mod.buildRiskFactorsDocx(), `Risk Factors.docx`)
      setMsg({ kind: 'ok', text: 'Word document downloaded.' })
    } catch (e) {
      setMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Export failed' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <Card title="Readiness">
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          <div>Narrative sections drafted: <b>{drafted.length} / {aiSections.length}</b></div>
          <div>Narrative sections approved: <b>{approved.length} / {aiSections.length}</b></div>
          <div style={{ color: 'var(--text-faint)', fontSize: 12, marginTop: 6 }}>
            Template sections (PCA, ESA, Property Details, Tax, Capital Structure, JV, Investor Company, Compensation, Subscription) fill automatically from the data sheet. Exhibits (financial forecasts, reports, agreements) are compiled separately, as with prior deals.
          </div>
        </div>
      </Card>
      <Card title="Word package">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button style={btnPrimary} disabled={busy !== null} onClick={() => exportDoc('ppm')}>
            {busy === 'ppm' ? 'Building…' : '⬇ Main PPM (.docx)'}
          </button>
          <button style={btn} disabled={busy !== null} onClick={() => exportDoc('offering')}>
            {busy === 'offering' ? 'Building…' : '⬇ Offering Page (.docx)'}
          </button>
          <button style={btn} disabled={busy !== null} onClick={() => exportDoc('risks')}>
            {busy === 'risks' ? 'Building…' : '⬇ Risk Factors (.docx)'}
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 10 }}>
          The main PPM downloads as an editable Word draft — finish, style, and circulate it exactly like prior deals. The Offering Page is the personalized cover (fill "Name of Offeree" per investor). Risk Factors is the standing page set.
        </div>
      </Card>
    </>
  )
}
