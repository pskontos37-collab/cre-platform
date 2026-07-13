import { supabase } from '../lib/supabase'

// Narrative document abstracts (doc_abstracts, migration 20240090). Generated
// on demand by the doc-abstract edge function; used by the Transactions and
// Management pages to compile a per-property "abstract of the active documents".

export interface DocAbstract {
  documentId: string
  propertyId: string | null
  kind: string
  title: string | null
  abstract: any
  generatedAt: string | null
}

export async function fetchDocAbstracts(documentIds: string[]): Promise<Map<string, DocAbstract>> {
  const map = new Map<string, DocAbstract>()
  if (!documentIds.length) return map
  const { data, error } = await supabase.from('doc_abstracts')
    .select('document_id, property_id, kind, title, abstract, generated_at')
    .in('document_id', documentIds)
  if (error) throw new Error(error.message)
  for (const r of (data ?? []) as any[]) {
    map.set(r.document_id, {
      documentId: r.document_id, propertyId: r.property_id, kind: r.kind,
      title: r.title, abstract: r.abstract, generatedAt: r.generated_at,
    })
  }
  return map
}

export async function generateDocAbstract(input: {
  documentId: string
  kind: 'transaction' | 'management' | 'document'
  propertyId?: string | null
  context?: unknown
  force?: boolean
}): Promise<any> {
  const { data, error } = await supabase.functions.invoke('doc-abstract', {
    body: {
      document_id: input.documentId,
      kind: input.kind,
      property_id: input.propertyId ?? null,
      context: input.context ?? null,
      force: !!input.force,
    },
  })
  if (error) throw new Error(error.message)
  const d = data as any
  if (d?.error) throw new Error(d.error)
  return d?.abstract
}
