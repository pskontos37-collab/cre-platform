import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { supabase } from '../lib/supabase'
import type { AbstractDoc } from './AbstractReport'
import { PdfDownloadButton, sanitizeFilename } from './PdfDownloadButton'

interface AbstractRowLite {
  tenant_name: string
  abstract: any
  generated_at: string | null
  source_doc_ids: string[] | null
}

type Scope = 'tenant' | 'property' | 'choose' | 'all'
type Format = 'full' | 'matrix'
type Output = 'pdf' | 'excel'

// Client-side full-pack PDF render is heavy (batched @react-pdf + pdf-lib merge,
// all on the main thread). The cap covers the full portfolio (~100 abstracts) with
// headroom; beyond SLOW_HINT tenants we warn that generation takes a while.
// Excel output is rows-only and has no cap.
const FULL_CAP = 150
const SLOW_HINT = 50

// Export toolbar for the Abstracts page. Scope (this tenant / this property /
// chosen properties / all properties) × format (full pack / clause matrix)
// × output (polished PDF / Excel workbook).
// Current-property rows come from the page; other scopes fetch on click. The
// "Choose properties" picker only lists properties that actually have abstracts.
export function AbstractsExportBar({ properties, propertyId, propertyName, selectedTenant, currentAbstracts }: {
  properties: Array<{ id: string; name: string }>
  propertyId: string | null
  propertyName: string
  selectedTenant: string | null
  currentAbstracts: AbstractRowLite[]
}) {
  const [scope, setScope] = useState<Scope>('property')
  const [format, setFormat] = useState<Format>('full')
  const [output, setOutput] = useState<Output>('pdf')
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  const withAbstract = useMemo(() => currentAbstracts.filter(a => a.abstract), [currentAbstracts])
  const selectedHasAbstract = !!selectedTenant && withAbstract.some(a => a.tenant_name.toLowerCase() === selectedTenant.toLowerCase())
  const nameById = useMemo(() => Object.fromEntries(properties.map(p => [p.id, p.name])), [properties])

  // One tiny query: how many abstracts each property has (drives the picker).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await supabase.from('lease_abstracts').select('property_id').not('abstract', 'is', null).limit(5000)
      if (cancelled) return
      const c: Record<string, number> = {}
      for (const r of (data ?? []) as any[]) c[r.property_id] = (c[r.property_id] ?? 0) + 1
      setCounts(c)
    })()
    return () => { cancelled = true }
  }, [])

  // Properties that actually have abstracts, for the picker.
  const pickable = useMemo(
    () => properties.filter(p => (counts?.[p.id] ?? 0) > 0).sort((a, b) => (counts![b.id] - counts![a.id])),
    [properties, counts],
  )

  // Seed the picker with the current property the first time it's opened.
  useEffect(() => {
    if (scope === 'choose' && chosen.size === 0 && counts && propertyId && (counts[propertyId] ?? 0) > 0) {
      setChosen(new Set([propertyId]))
    }
  }, [scope, counts, propertyId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close the picker on outside click.
  useEffect(() => {
    if (!pickerOpen) return
    const onDown = (e: MouseEvent) => { if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [pickerOpen])

  const chosenCount = useMemo(() => [...chosen].reduce((s, id) => s + (counts?.[id] ?? 0), 0), [chosen, counts])

  const toDoc = (r: AbstractRowLite & { property_id?: string }, propName: string): AbstractDoc => ({
    propertyName: propName,
    tenantName: r.tenant_name,
    abstract: r.abstract,
    generatedAt: r.generated_at,
    sourceDocCount: r.source_doc_ids?.length ?? 0,
  })

  async function fetchDocsFor(ids: string[]): Promise<AbstractDoc[]> {
    const { data, error } = await supabase
      .from('lease_abstracts')
      .select('property_id, tenant_name, abstract, generated_at, source_doc_ids')
      .in('property_id', ids)
      .limit(2000)
    if (error) throw new Error(error.message)
    return ((data ?? []) as any[]).filter(r => r.abstract).map(r => toDoc(r, nameById[r.property_id] ?? '—'))
  }

  async function gatherDocs(): Promise<AbstractDoc[]> {
    if (scope === 'tenant') {
      return withAbstract
        .filter(a => selectedTenant && a.tenant_name.toLowerCase() === selectedTenant.toLowerCase())
        .map(a => toDoc(a, propertyName))
    }
    if (scope === 'property') return withAbstract.map(a => toDoc(a, propertyName))
    if (scope === 'choose') return fetchDocsFor([...chosen])
    return fetchDocsFor(properties.map(p => p.id)) // all
  }

  const generatedAt = () => new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })

  const scopeName =
    scope === 'tenant' ? (selectedTenant ?? 'tenant')
      : scope === 'property' ? propertyName
        : scope === 'choose' ? (chosen.size === 1 ? (nameById[[...chosen][0]] ?? 'property') : `${chosen.size}-Properties`)
          : 'All-Properties'
  const filename = `${format === 'matrix' ? 'Wilkow-Clause-Matrix' : 'Wilkow-Abstracts'}-${sanitizeFilename(scopeName)}.${output === 'excel' ? 'xlsx' : 'pdf'}`

  // Count known before click; enforce the full-pack cap. PDF only — the Excel
  // workbook is one row per tenant, so any scope is fine. For 'all' the count
  // comes from the per-property tally (Infinity until it loads, so the button
  // can't fire on an unknown-size pack).
  const knownFullCount =
    scope === 'property' ? withAbstract.length
      : scope === 'choose' ? chosenCount
        : scope === 'all' ? (counts ? Object.values(counts).reduce((s, n) => s + n, 0) : Infinity)
          : 0
  const blockReason =
    output === 'pdf' && format === 'full' && knownFullCount > FULL_CAP
      ? `Full-pack PDF is limited to ${FULL_CAP} tenants (${knownFullCount === Infinity ? 'counting…' : knownFullCount} selected) — use Clause matrix, Excel, or fewer properties`
      : null
  const slowHint =
    !blockReason && output === 'pdf' && format === 'full' && knownFullCount > SLOW_HINT && knownFullCount !== Infinity
      ? `Large pack (${knownFullCount} tenants) — generation can take a few minutes; keep this tab open`
      : null

  const disabled =
    (scope === 'tenant' && !selectedHasAbstract) ||
    (scope === 'property' && withAbstract.length === 0) ||
    (scope === 'choose' && chosen.size === 0) ||
    !!blockReason

  async function build(): Promise<Blob> {
    const docs = await gatherDocs()
    if (docs.length === 0) throw new Error('No abstracts in the selected scope')
    if (output === 'pdf' && format === 'full' && docs.length > FULL_CAP) {
      throw new Error(`Full-pack PDF is limited to ${FULL_CAP} tenants (${docs.length} selected). Use the Clause matrix, Excel, or fewer properties.`)
    }

    const propCount = new Set(docs.map(d => d.propertyName)).size
    const multiProperty = propCount > 1
    const gen = generatedAt()

    const scopeTitle =
      scope === 'tenant' ? (docs[0]?.tenantName ?? 'Lease Abstract')
        : scope === 'property' ? propertyName
          : scope === 'choose' ? (chosen.size === 1 ? (nameById[[...chosen][0]] ?? 'Selected') : `${chosen.size} Properties`)
            : 'All Properties'
    const countLabel = `${docs.length} ${docs.length === 1 ? 'abstract' : 'abstracts'}${multiProperty ? ` across ${propCount} properties` : ''}`

    if (output === 'excel') {
      const { buildClauseMatrixXlsx, buildAbstractsXlsx } = await import('./abstractsExcel')
      const input = {
        title: format === 'matrix' ? `Clause Matrix — ${scopeTitle}` : `Lease Abstracts — ${scopeTitle}`,
        subtitle: format === 'matrix' ? `${countLabel} · key-clause comparison` : countLabel,
        docs,
        generatedAt: gen,
      }
      return format === 'matrix' ? buildClauseMatrixXlsx(input) : buildAbstractsXlsx(input)
    }

    if (format === 'matrix') {
      const { buildClauseMatrixPdf } = await import('./ClauseMatrixReport')
      return buildClauseMatrixPdf({
        title: `Clause Matrix — ${scopeTitle}`,
        subtitle: `${countLabel} · key-clause comparison`,
        docs,
        generatedAt: gen,
      })
    }
    const { buildAbstractsPackPdf } = await import('./AbstractReport')
    return buildAbstractsPackPdf({
      title: scope === 'tenant' ? scopeTitle : `Lease Abstracts — ${scopeTitle}`,
      subtitle: scope === 'tenant' ? `Lease abstract${docs[0]?.propertyName ? ` · ${docs[0].propertyName}` : ''}` : countLabel,
      docs,
      generatedAt: gen,
      showPropertyHeadings: multiProperty,
    })
  }

  const sel: CSSProperties = {
    background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 6,
    color: 'var(--text)', fontSize: 12, padding: '7px 10px',
  }

  function toggleProp(id: string) {
    setChosen(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      {blockReason && (
        <span style={{ fontSize: 11, color: 'var(--amber)', maxWidth: 320, textAlign: 'right', lineHeight: 1.3 }}>{blockReason}</span>
      )}
      {slowHint && (
        <span style={{ fontSize: 11, color: 'var(--text-faint)', maxWidth: 320, textAlign: 'right', lineHeight: 1.3 }}>{slowHint}</span>
      )}

      <select value={scope} onChange={e => { setScope(e.target.value as Scope); setPickerOpen(e.target.value === 'choose') }} style={sel} title="What to include">
        <option value="tenant" disabled={!selectedHasAbstract}>This tenant{selectedTenant ? ` (${selectedTenant})` : ''}</option>
        <option value="property">All in {propertyName || 'this property'}</option>
        <option value="choose">Choose properties…</option>
        <option value="all">All properties</option>
      </select>

      {/* multi-property picker */}
      {scope === 'choose' && (
        <div ref={pickerRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setPickerOpen(o => !o)}
            style={{ ...sel, cursor: 'pointer', whiteSpace: 'nowrap' }}
            title="Pick which properties to include"
          >
            {chosen.size === 0 ? 'Select properties ▾' : `${chosen.size} ${chosen.size === 1 ? 'property' : 'properties'} · ${chosenCount} tenants ▾`}
          </button>
          {pickerOpen && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 60, minWidth: 240,
              background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 8,
              boxShadow: '0 8px 24px rgba(0,0,0,0.28)', padding: 8,
            }}>
              {!counts && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', padding: 6 }}>Loading…</div>}
              {counts && pickable.length === 0 && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', padding: 6 }}>No abstracts yet</div>}
              {pickable.map(p => {
                const on = chosen.has(p.id)
                return (
                  <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, color: 'var(--text)' }}>
                    <input type="checkbox" checked={on} onChange={() => toggleProp(p.id)} />
                    <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{counts![p.id]}</span>
                  </label>
                )
              })}
              {counts && pickable.length > 1 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 6 }}>
                  <button onClick={() => setChosen(new Set(pickable.map(p => p.id)))} style={{ fontSize: 11, background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer' }}>Select all</button>
                  <button onClick={() => setChosen(new Set())} style={{ fontSize: 11, background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer' }}>Clear</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <select value={format} onChange={e => setFormat(e.target.value as Format)} style={sel} title="Report format">
        <option value="full">Full abstracts</option>
        <option value="matrix">Clause matrix</option>
      </select>

      <select value={output} onChange={e => setOutput(e.target.value as Output)} style={sel} title="Output file type">
        <option value="pdf">Polished PDF</option>
        <option value="excel">Excel (.xlsx)</option>
      </select>

      <PdfDownloadButton
        label={output === 'excel' ? '⬇ Excel' : '⬇ PDF'}
        busyLabel={output === 'excel' ? 'Generating Excel…' : undefined}
        filename={filename}
        build={build}
        disabled={disabled}
        title={blockReason ?? (disabled ? 'Nothing selected to export' : output === 'excel' ? 'Download the selected abstracts as an Excel workbook' : 'Download the selected abstracts as a branded PDF')}
      />
    </span>
  )
}
