import { supabase } from '../lib/supabase'
import { useQuery } from './useQuery'
import { FORM_VERSION, templateFor, type FormKind } from '../lib/inspectionTemplates'
import { ratingFor, scoreOf, type SectionResponse } from '../lib/inspection'

export interface InspectionListRow {
  id: string
  property_id: string
  inspection_date: string
  inspected_by: string | null
  form_kind: FormKind | null
  form_version: string | null
  status: string
  average_score: number | null
  items_scored: number | null
  items_flagged: number | null
  pdf_path: string | null
  created_at: string
  pdfUrl: string | null
}

/** Inspections for one property, newest first, each report PDF signed. Includes
 *  drafts (status='draft') so the page can offer Resume. */
export function useInspections(propertyId: string | null, bump = 0) {
  return useQuery<InspectionListRow[]>(async () => {
    if (!propertyId) return []
    const { data, error } = await supabase
      .from('inspections')
      .select('id, property_id, inspection_date, inspected_by, form_kind, form_version, status, average_score, items_scored, items_flagged, pdf_path, created_at')
      .eq('property_id', propertyId)
      .order('inspection_date', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Omit<InspectionListRow, 'pdfUrl'>[]

    const paths = rows.map(r => r.pdf_path).filter((p): p is string => !!p)
    const signed = new Map<string, string>()
    if (paths.length) {
      const { data: s } = await supabase.storage.from('documents').createSignedUrls(paths, 3600)
      for (const it of s ?? []) if (it.path && it.signedUrl) signed.set(it.path, it.signedUrl)
    }
    return rows.map(r => ({ ...r, pdfUrl: r.pdf_path ? signed.get(r.pdf_path) ?? null : null }))
  }, [propertyId, bump])
}

export interface EditableInspection {
  id: string
  kind: FormKind
  inspectionDate: string
  inspectedBy: string
  weather: string
  specialEvents: string
  comments: string
  actionItems: string
  sections: SectionResponse[]          // item.photos hold existing storage keys
  photoUrls: Record<string, string>    // storage key -> signed URL (for thumbnails)
}

/** Load a draft (or any inspection) for editing, signing its existing photos. */
export async function fetchInspectionForEdit(id: string): Promise<EditableInspection> {
  const { data, error } = await supabase
    .from('inspections')
    .select('id, form_kind, form_version, inspection_date, inspected_by, weather, special_events, comments, action_items, responses')
    .eq('id', id)
    .single()
  if (error) throw new Error(error.message)
  const row = data as {
    id: string; form_kind: FormKind | null; inspection_date: string; inspected_by: string | null
    weather: string | null; special_events: string | null; comments: string | null
    action_items: string | null; responses: SectionResponse[] | null
  }
  const sections = row.responses ?? []
  const keys = sections.flatMap(s => s.items).flatMap(it => it.photos ?? [])
  const photoUrls: Record<string, string> = {}
  if (keys.length) {
    const { data: s } = await supabase.storage.from('documents').createSignedUrls(keys, 3600)
    for (const it of s ?? []) if (it.path && it.signedUrl) photoUrls[it.path] = it.signedUrl
  }
  return {
    id: row.id,
    kind: (row.form_kind ?? 'retail') as FormKind,
    inspectionDate: row.inspection_date,
    inspectedBy: row.inspected_by ?? '',
    weather: row.weather ?? '',
    specialEvents: row.special_events ?? '',
    comments: row.comments ?? '',
    actionItems: row.action_items ?? '',
    sections,
    photoUrls,
  }
}

// ── persist (draft save + final submit share one path) ─────────────────────────

export interface PersistArgs {
  id?: string                          // present when resuming/updating a draft
  status: 'draft' | 'submitted'
  propertyId: string
  propertyName: string
  kind: FormKind
  inspectionDate: string
  inspectedBy: string
  weather: string
  specialEvents: string
  comments: string
  actionItems: string
  sections: SectionResponse[]          // item.photos hold EXISTING keys to keep
  newPhotos: Record<number, File[]>    // item number -> newly attached files
  uploadedBy: string | null
}

export interface PersistResult {
  id: string
  status: 'draft' | 'submitted'
  pdfUrl: string | null
}

async function resizeToJpeg(file: File, maxDim = 1400, quality = 0.8): Promise<{ blob: Blob; dataUrl: string }> {
  const dataUrlIn = await new Promise<string>((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(fr.result as string)
    fr.onerror = () => rej(new Error('read failed'))
    fr.readAsDataURL(file)
  })
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const im = new window.Image()
    im.onload = () => res(im)
    im.onerror = () => rej(new Error('decode failed'))
    im.src = dataUrlIn
  })
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return { blob: file, dataUrl: dataUrlIn }
  ctx.drawImage(img, 0, 0, w, h)
  const dataUrl = canvas.toDataURL('image/jpeg', quality)
  const blob = await new Promise<Blob>((res) => canvas.toBlob(b => res(b ?? file), 'image/jpeg', quality))
  return { blob, dataUrl }
}

async function urlToDataUrl(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url)
    const blob = await resp.blob()
    return await new Promise<string>((res, rej) => {
      const fr = new FileReader()
      fr.onload = () => res(fr.result as string)
      fr.onerror = () => rej(new Error('read failed'))
      fr.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/**
 * Saves an inspection as a draft or a final submission. Drafts skip PDF/report
 * generation (fast, connection-resilient); submitting builds the branded PDF
 * (embedding existing + new photos), files it as a document, and marks it
 * submitted. A client-generated id lets photo/PDF keys precede the insert and
 * lets the same row be updated across draft→submit.
 */
export async function persistInspection(args: PersistArgs): Promise<PersistResult> {
  const id = args.id ?? crypto.randomUUID()
  const base = `p/${args.propertyId}/inspections/${id}`

  // upload newly-attached photos; remember their data URLs for the PDF
  const newKeysByItem: Record<number, string[]> = {}
  const newDataByItem: Record<number, string[]> = {}
  for (const [nStr, files] of Object.entries(args.newPhotos)) {
    const n = Number(nStr)
    if (!files?.length) continue
    newKeysByItem[n] = []; newDataByItem[n] = []
    for (let i = 0; i < files.length; i++) {
      const { blob, dataUrl } = await resizeToJpeg(files[i])
      const key = `${base}/photo-${n}-${crypto.randomUUID().slice(0, 8)}.jpg`
      const { error } = await supabase.storage.from('documents').upload(key, blob, { contentType: 'image/jpeg', upsert: true })
      if (error) throw new Error(`Photo upload failed (item ${n}): ${error.message}`)
      newKeysByItem[n].push(key)
      newDataByItem[n].push(dataUrl)
    }
  }

  // fold existing + new keys into the stored responses
  const storedSections: SectionResponse[] = args.sections.map(sec => ({
    title: sec.title,
    items: sec.items.map(it => ({ ...it, photos: [...(it.photos ?? []), ...(newKeysByItem[it.n] ?? [])] })),
  }))
  const allKeys = storedSections.flatMap(s => s.items).flatMap(it => it.photos)
  const score = scoreOf(args.sections)
  const tpl = templateFor(args.kind)

  let pdfPath: string | null = null
  let documentId: string | null = null

  if (args.status === 'submitted') {
    // assemble per-item photo data URLs in final order (existing first, then new)
    const photosByItem: Record<number, string[]> = {}
    for (const sec of args.sections) {
      for (const it of sec.items) {
        const existing = it.photos ?? []
        const urls: string[] = []
        for (const key of existing) {
          const { data: signed } = await supabase.storage.from('documents').createSignedUrl(key, 600)
          const d = signed?.signedUrl ? await urlToDataUrl(signed.signedUrl) : null
          if (d) urls.push(d)
        }
        urls.push(...(newDataByItem[it.n] ?? []))
        if (urls.length) photosByItem[it.n] = urls
      }
    }

    const { buildInspectionPdf } = await import('../reports/InspectionReport')
    const pdfBlob = await buildInspectionPdf({
      propertyName: args.propertyName,
      formTitle: tpl.title,
      formVersion: tpl.version || FORM_VERSION,
      inspectionDate: args.inspectionDate,
      inspectedBy: args.inspectedBy,
      weather: args.weather,
      specialEvents: args.specialEvents,
      sections: storedSections,
      photosByItem,
      comments: args.comments,
      actionItems: args.actionItems,
      score,
      generatedAt: new Date().toLocaleString(),
    })
    pdfPath = `${base}.pdf`
    const { error: pdfErr } = await supabase.storage.from('documents').upload(pdfPath, pdfBlob, { contentType: 'application/pdf', upsert: true })
    if (pdfErr) throw new Error(`Report upload failed: ${pdfErr.message}`)

    // file the PDF as a document (best-effort — a PM without can_upload still
    // gets the inspection recorded; report stays viewable via pdf_path)
    const docId = crypto.randomUUID()
    const { error: docErr } = await supabase.from('documents').insert({
      id: docId,
      property_id: args.propertyId,
      doc_type: 'inspection',
      title: `${tpl.title} — ${args.inspectionDate}`,
      file_name: `${tpl.title} - ${args.propertyName} - ${args.inspectionDate}.pdf`,
      mime_type: 'application/pdf',
      file_size_bytes: pdfBlob.size,
      storage_path: pdfPath,
      upload_date: args.inspectionDate,
      uploaded_by: args.uploadedBy,
      is_indexed: false,
    })
    if (docErr) console.warn('[inspection] report not filed to documents:', docErr.message)
    else documentId = docId
  }

  const rowBase = {
    property_id: args.propertyId,
    inspected_by: args.inspectedBy || null,
    inspection_date: args.inspectionDate,
    inspection_type: 'routine' as const,
    form_kind: args.kind,
    form_version: tpl.version,
    status: args.status,
    weather: args.weather || null,
    special_events: args.specialEvents || null,
    responses: storedSections,
    average_score: score.average,
    items_scored: score.scored,
    items_flagged: score.flagged,
    comments: args.comments || null,
    action_items: args.actionItems || null,
    photo_paths: allKeys,
    condition_rating: args.status === 'submitted' ? ratingFor(score.average) : null,
    summary: args.status === 'submitted' && score.average != null
      ? `Overall ${score.average.toFixed(2)}/5 across ${score.scored} items${score.flagged ? `, ${score.flagged} flagged` : ''}.`
      : null,
    uploaded_by: args.uploadedBy,
    updated_at: new Date().toISOString(),
  }

  if (args.id) {
    // resuming: keep any existing document link unless we just created one
    const patch = documentId ? { ...rowBase, pdf_path: pdfPath, document_id: documentId } : { ...rowBase, ...(pdfPath ? { pdf_path: pdfPath } : {}) }
    const { error } = await supabase.from('inspections').update(patch).eq('id', args.id)
    if (error) throw new Error(`Saving the inspection failed: ${error.message}`)
  } else {
    const { error } = await supabase.from('inspections').insert({
      id, ...rowBase, pdf_path: pdfPath, document_id: documentId,
    })
    if (error) throw new Error(`Saving the inspection failed: ${error.message}`)
  }

  let pdfUrl: string | null = null
  if (pdfPath) {
    const { data: signed } = await supabase.storage.from('documents').createSignedUrl(pdfPath, 3600)
    pdfUrl = signed?.signedUrl ?? null
  }
  return { id, status: args.status, pdfUrl }
}
