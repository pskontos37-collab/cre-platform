// doc-inbox — HTTP drop-box for documents that arrive OUTSIDE the file-share
// sync (typically: an executed amendment emailed to an asset manager).
//
// POST JSON:
//   { property_id?: uuid,            // preferred
//     property_hint?: string,        // else resolved via ILIKE against properties.name
//     file_name: string,             // "AMD-3rd-Kay Jewelers (7-9-26).pdf"
//     pdf_base64: string }           // the attachment, base64 (≤20MB)
//
// Flow: store to documents bucket under p/<property>/inbox/… → invoke
// pdf-extract?store=1 (creates the documents row + summary chunks) → done.
// The nightly refresh_abstracts.ps1 then sees the new documents row and
// auto-regenerates any affected abstract (living-abstracts loop), and the weekly
// corpus_hygiene sweep adds the verbatim-text/OCR layer.
//
// Wiring an Outlook rule (IT, one-time): a Power Automate flow on a shared
// mailbox — "when email arrives with attachment → HTTP POST this function" with
// Authorization: Bearer <EDGE_SERVICE_SECRET or sb_secret key>. Per-property
// mailbox folders can hard-code property_id; otherwise pass the property name
// from the subject line as property_hint.
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canReadProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const MAX_BYTES = 20 * 1024 * 1024

serve(async (req) => {
  const CORS = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const caller = await requireUser(req, sb)

    const body = await req.json().catch(() => ({}))
    const fileName: string = (body.file_name ?? '').trim()
    const b64: string = body.pdf_base64 ?? ''
    if (!fileName || !b64) throw new Error('file_name and pdf_base64 are required')
    if (!/\.pdf$/i.test(fileName)) throw new Error('only .pdf attachments are accepted')

    // Resolve the property.
    let propertyId: string | null = body.property_id ?? null
    if (!propertyId && body.property_hint) {
      const { data: props } = await sb.from('properties').select('id, name')
        .ilike('name', `%${String(body.property_hint).replace(/[%_]/g, ' ').trim()}%`).limit(2)
      if (props?.length === 1) propertyId = props[0].id
      else throw new Error(`property_hint "${body.property_hint}" matched ${props?.length ?? 0} properties — pass property_id`)
    }
    if (!propertyId) throw new Error('property_id or a resolvable property_hint is required')
    if (!canReadProperty(caller, propertyId)) throw new AuthError('No access to this property', 403)

    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
    if (bytes.length > MAX_BYTES) throw new Error(`attachment is ${(bytes.length / 1048576).toFixed(1)}MB — exceeds the 20MB inbox cap`)

    // Store under the property's key prefix (matches the storage RLS convention).
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const safeName = fileName.replace(/[^\w.\- ()#&']/g, '_')
    const storagePath = `p/${propertyId}/inbox/${stamp}_${safeName}`
    const { error: upErr } = await sb.storage.from('documents')
      .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: false })
    if (upErr) throw new Error('storage upload failed: ' + upErr.message)

    // Standard ingestion: pdf-extract store=1 creates the documents row +
    // summary chunks (same path as the file-share loader).
    const fnBase = Deno.env.get('SUPABASE_URL')! + '/functions/v1'
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const qp = new URLSearchParams({
      storagePath: `documents/${storagePath}`, store: '1', propertyId,
      filePath: `email-inbox:${fileName}`,
    })
    const xr = await fetch(`${fnBase}/pdf-extract?${qp}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${svc}`, apikey: svc },
    })
    const xd = await xr.json().catch(() => ({}))
    if (!xr.ok) {
      // File is stored even if extraction fails — the weekly hygiene sweep or a
      // manual retry can extract it later. Surface the state honestly.
      return new Response(JSON.stringify({
        success: true, stored: storagePath, extracted: false,
        extract_error: xd.error ?? `pdf-extract http ${xr.status}`,
      }), { status: 202, headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({
      success: true, stored: storagePath, extracted: true,
      document_id: xd.document_id ?? null, doc_type: xd.extraction?.doc_type ?? null,
    }), { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = err instanceof AuthError ? err.status : 400
    return new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
