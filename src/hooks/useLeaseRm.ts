import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// Lease repair & maintenance responsibility matrix (lease_rm_matrix, migration
// 20240084; extracted by scripts/extract_rm_matrix.ps1). The /workorders panel
// matches these rows to a work order's category so the manager can see whether
// the lease makes the issue a landlord or tenant responsibility — always with
// the verbatim quote + section and a link to the lease PDF for verification.

export interface LeaseRmRow {
  id: string
  system: string
  responsible: 'landlord' | 'tenant' | 'shared' | 'unclear'
  summary: string | null
  quote: string | null
  sectionRef: string | null
  sourceDocIds: string[]
  verified: boolean
}

export interface LeaseRmData {
  rows: LeaseRmRow[]
  // title of the primary governing lease doc, for the /documents?q= handoff
  leaseDocTitle: string | null
}

const cache = new Map<string, LeaseRmData>()

export async function fetchLeaseRm(propertyId: string, tenantName: string): Promise<LeaseRmData> {
  const key = `${propertyId}::${tenantName.toLowerCase()}`
  const hit = cache.get(key)
  if (hit) return hit

  const { data, error } = await supabase
    .from('lease_rm_matrix')
    .select('id, system, responsible, summary, quote, section_ref, source_doc_ids, verified')
    .eq('property_id', propertyId)
    .ilike('tenant_name', tenantName)
  if (error) throw new Error(error.message)

  const rows: LeaseRmRow[] = ((data ?? []) as any[]).map(r => ({
    id: r.id,
    system: r.system,
    responsible: r.responsible,
    summary: r.summary,
    quote: r.quote,
    sectionRef: r.section_ref,
    sourceDocIds: (r.source_doc_ids ?? []) as string[],
    verified: r.verified,
  }))

  // Resolve the first governing doc's title so the panel can hand off to
  // /documents?q=<title> (same pattern as the Services page → doc-search).
  let leaseDocTitle: string | null = null
  const firstDoc = rows.find(r => r.sourceDocIds.length)?.sourceDocIds[0]
  if (firstDoc) {
    const { data: doc } = await supabase.from('documents').select('title').eq('id', firstDoc).maybeSingle()
    leaseDocTitle = (doc as { title: string } | null)?.title ?? null
  }

  const result = { rows, leaseDocTitle }
  cache.set(key, result)
  return result
}

export function useLeaseRm(propertyId: string, tenantName: string) {
  const [data, setData] = useState<LeaseRmData | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setData(null); setError(null)
    fetchLeaseRm(propertyId, tenantName)
      .then(d => { if (alive) setData(d) })
      .catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive = false }
  }, [propertyId, tenantName])

  return { data, error }
}

/** Pick the matrix row that governs a work order's category (most specific first). */
export function rmRowForCategory(rows: LeaseRmRow[], systems: string[]): LeaseRmRow | null {
  for (const s of systems) {
    const row = rows.find(r => r.system === s)
    if (row) return row
  }
  return null
}
