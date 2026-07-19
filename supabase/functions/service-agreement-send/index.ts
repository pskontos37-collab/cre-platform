// service-agreement-send — emails a generated service agreement to a vendor for
// signature, with the PDF package attached.
//
// The frontend (/services/new) generates the PDF package client-side (agreement
// + Exhibit A + Exhibit B), base64-encodes it, and POSTs it here. This function
// attaches it to a short Wilkow-branded cover email via the Resend API. The
// vendor signs (wet or their own e-sign) and returns it.
//
// Auth: any ACTIVE authenticated user (property managers issue vendor
//       contracts), via requireUser. Mirrors the other edge functions.
// Send: Resend HTTP API. Requires the RESEND_API_KEY function secret; from
//       address is SERVICE_AGREEMENT_FROM, else DIGEST_FROM, else Resend's
//       onboarding sender (works for a first test before a domain is verified).
//
// POST JSON:
//   {
//     "to": "vendor@example.com",          // required
//     "vendorName": "Baker Roofing",       // optional (cover text)
//     "propertyName": "Midway Plantation Shopping Center",
//     "filename": "Service-Agreement-KME-Baker-Roofing.pdf",
//     "pdfBase64": "<base64 of the PDF package>",   // required
//     "hasExhibitA": true,
//     "message": "optional custom cover note",
//     "cc": ["pm@wilkow.com"]              // optional
//   }
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY.
// Optional secrets: SERVICE_AGREEMENT_FROM, DIGEST_FROM.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, corsHeaders, requireUser } from '../_shared/auth.ts'

const FROM =
  Deno.env.get('SERVICE_AGREEMENT_FROM') ??
  Deno.env.get('DIGEST_FROM') ??
  'M&J Wilkow <onboarding@resend.dev>'
const WILKOW = '#466371', MIST = '#8fa2ad'

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

function coverHtml(vendorName: string, propertyName: string, custom: string | null, hasExhibitA: boolean): string {
  const intro = custom
    ? esc(custom).replace(/\n/g, '<br>')
    : `Please find attached the Service Agreement for <b>${esc(propertyName)}</b> for your review and signature. ` +
      `Sign where indicated on the signature page and return an executed copy at your convenience. ` +
      `The attachment includes the agreement${hasExhibitA ? ', your proposal (Exhibit A),' : ''} and the insurance requirements (Exhibit B).`
  return `<div style="font-family:Georgia,'Times New Roman',serif;max-width:620px;margin:0 auto;padding:24px;color:#1c2b33;">
    <div style="border-bottom:2px solid ${WILKOW};padding-bottom:12px;margin-bottom:18px;">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.26em;text-transform:uppercase;color:${MIST};">M&amp;J Wilkow · Property Operations</div>
      <div style="font-size:20px;font-weight:600;color:#1c2b33;margin-top:4px;">Service Agreement for Signature</div>
    </div>
    <p style="font-size:14px;line-height:1.5;">${vendorName ? `Dear ${esc(vendorName)},` : 'Hello,'}</p>
    <p style="font-size:14px;line-height:1.5;">${intro}</p>
    <p style="font-size:14px;line-height:1.5;">Thank you,<br>M&amp;J Wilkow Properties, LLC</p>
    <p style="font-size:10.5px;color:#9aa8ae;margin-top:22px;font-family:Arial,sans-serif;">Sent via the M&amp;J Wilkow asset-management platform. If you received this in error, please disregard.</p>
  </div>`
}

serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    // WRITE gate (audit S2): this sends EXTERNAL EMAIL with a caller-supplied
    // recipient, body and attachment from the company address — an outbound
    // communication, not a read. Full-access callers only (admin / asset_manager /
    // global grant / service token). All current operators are privileged, so
    // this changes nothing today; it closes the relay for future scoped users.
    const caller = await requireUser(req, sb)
    if (caller.access !== 'all') throw new AuthError('Not permitted to send external email', 403)

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const to = String(body.to ?? '').trim()
    const pdfBase64 = String(body.pdfBase64 ?? '')
    const filename = String(body.filename ?? 'Service-Agreement.pdf')
    const vendorName = String(body.vendorName ?? '').trim()
    const propertyName = String(body.propertyName ?? '').trim()
    const custom = body.message ? String(body.message) : null
    const hasExhibitA = body.hasExhibitA === true
    const cc = Array.isArray(body.cc) ? body.cc.map((s: unknown) => String(s).trim()).filter(Boolean) : undefined

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new AuthError('A valid "to" address is required', 400)
    if (!pdfBase64 || pdfBase64.length < 100) throw new AuthError('Missing PDF attachment (pdfBase64)', 400)

    const RESEND = Deno.env.get('RESEND_API_KEY')
    if (!RESEND) throw new Error('RESEND_API_KEY not set — add it as a function secret to enable sending')

    const subject = `Service Agreement for Signature${propertyName ? ` — ${propertyName}` : ''}`
    const html = coverHtml(vendorName, propertyName, custom, hasExhibitA)

    const send = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [to],
        cc,
        subject,
        html,
        attachments: [{ filename, content: pdfBase64 }],
      }),
    })
    const sendBody = await send.json().catch(() => ({}))
    if (!send.ok) throw new Error(`Resend rejected: ${JSON.stringify(sendBody).slice(0, 300)}`)

    return new Response(JSON.stringify({ sent: true, id: sendBody?.id, to }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 500
    const msg = err instanceof Error ? err.message : String(err)
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
