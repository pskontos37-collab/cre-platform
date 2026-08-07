import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'

// "Have we looked at this before?" — searches comps.folder_index (one row per
// K:\ASSTMGMT\ACQUISITIONS deal folder, loaded by scripts/load_folder_index.ps1,
// migration 20240203). The comps DB only covers the 1,013 folders with CF
// models; this index covers all 2,397 deal folders, so a prior look with only
// an OM/teaser on file still surfaces. Read-only, in-flow (sits under the
// comps panel on the Underwriting tab), auto-seeded from the deal name + city.

interface FolderRow {
  id: string
  market: string
  folder_name: string
  norm_name: string
  n_files: number
  total_mb: number
  first_year: number | null
  last_year: number | null
  n_cf_models: number
  n_oms: number
  n_rent_rolls: number
  n_lease_docs: number
  n_argus: number
  source_property_id: string | null
  inventoried_at: string
}

// Mirrors the loader's Norm(): lowercase, non-alphanumerics to spaces, collapse.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

// Generic words that match half the corpus — not identity evidence on their own.
const STOP = new Set(['shopping', 'center', 'centre', 'plaza', 'marketplace', 'market', 'commons', 'crossing', 'square', 'village', 'place', 'north', 'south', 'east', 'west', 'the'])

function tokensOf(q: string): string[] {
  return [...new Set(norm(q).split(' ').filter(t => t.length >= 4 && !STOP.has(t)))].slice(0, 5)
}

async function searchFolders(q: string): Promise<FolderRow[]> {
  const toks = tokensOf(q)
  if (!toks.length) return []
  const { data, error } = await supabase
    .schema('comps')
    .from('folder_index')
    .select('*')
    .or(toks.map(t => `norm_name.ilike.%${t}%`).join(','))
    .order('n_files', { ascending: false })
    .limit(25)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as FolderRow[]
  // Rank: tokens matched first, then evidence depth (models beat loose files).
  const score = (r: FolderRow) => toks.filter(t => r.norm_name.includes(t)).length
  return rows
    .sort((a, b) => score(b) - score(a) || b.n_cf_models - a.n_cf_models || b.n_files - a.n_files)
    .slice(0, 8)
}

export function PriorLooksPanel({ dealName, city }: { dealName: string; city: string | null }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<FolderRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [q, setQ] = useState('')

  const autoQuery = useMemo(() => [dealName, city ?? ''].join(' '), [dealName, city])

  useEffect(() => {
    let live = true
    setRows(null); setError(null)
    searchFolders(q.trim() || autoQuery)
      .then(r => { if (live) setRows(r) })
      .catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [autoQuery, q])

  const n = rows?.length ?? 0
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', color: 'inherit',
        }}
      >
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--text)' }}>Prior looks</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {rows === null ? 'searching the acquisitions archive…'
            : n === 0 ? 'no matching deal folder on K:\\'
            : `${n} matching folder${n === 1 ? '' : 's'} in the acquisitions archive`}
        </span>
      </button>
      {open && (
        <div style={{ padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder={`Search 2,397 deal folders… (auto: ${tokensOf(autoQuery).join(' ') || '—'})`}
            style={{
              fontSize: 12, padding: '6px 9px', borderRadius: 6, background: 'var(--surface-2)',
              color: 'var(--text)', border: '1px solid var(--border-2)', outline: 'none',
            }}
          />
          {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{error}</div>}
          {rows !== null && rows.length === 0 && !error && (
            <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
              No prior look found under a matching folder name — this appears to be a first look.
            </div>
          )}
          {(rows ?? []).map(r => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, borderTop: '1px solid var(--border)', paddingTop: 7, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                {r.market}\{r.folder_name}
              </span>
              {r.first_year != null && (
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {r.first_year === r.last_year ? r.first_year : `${r.first_year}–${r.last_year}`}
                </span>
              )}
              <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                {r.n_cf_models > 0 ? `${r.n_cf_models} model${r.n_cf_models === 1 ? '' : 's'} · ` : ''}
                {r.n_oms > 0 ? `${r.n_oms} OM${r.n_oms === 1 ? '' : 's'} · ` : ''}
                {r.n_lease_docs > 0 ? `${r.n_lease_docs} lease docs · ` : ''}
                {r.n_files.toLocaleString()} files
              </span>
              {r.source_property_id && (
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: 99, padding: '1px 7px' }}>
                  comps loaded
                </span>
              )}
            </div>
          ))}
          {rows !== null && rows.length > 0 && (
            <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>
              From the K:\ acquisitions inventory ({rows[0].inventoried_at} scan). Folder names only — a
              different working name will not match; try a landmark or street token.
            </div>
          )}
        </div>
      )}
    </div>
  )
}
