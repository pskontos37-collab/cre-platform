// announcement-send — emails a property announcement to selected tenants.
//
// The /announcements page builds the recipient list client-side (union of
// tenant_contacts with an email + active work_order_portal_users, deduped) and
// POSTs it here with the subject/message. Each recipient gets an INDIVIDUAL
// email (no shared To: line — tenants never see each other's addresses), sent
// through the Resend batch endpoint in chunks. Reply-To is the sending
// manager, so tenant replies land in their real inbox.
//
// Auth: any ACTIVE staff user via requireUser, then canReadProperty gates the
//       target property (PMs can only announce to their own assignments).
// Audit: writes tenant_announcements + tenant_announcement_recipients with the
//        service role (tables have read-only RLS for staff).
//
// POST JSON:
//   {
//     "propertyId": "<uuid>",                 // required
//     "propertyName": "Gateway Center",       // cover text
//     "subject": "Parking lot repaving",      // required
//     "message": "plain text body",           // required (blank lines = paragraphs)
//     "recipientMode": "all" | "selected",
//     "recipients": [                          // required, 1..500
//       { "email": "t@x.com", "name": "Jane", "tenantName": "Starbucks",
//         "tenantId": "<uuid>|null", "source": "tenant_contacts" }
//     ],
//     "ccSender": true                         // also send the manager a copy
//   }
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY.
// Optional secrets: ANNOUNCEMENT_FROM, DIGEST_FROM (sender fallback chain).

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, canWriteProperty, corsHeaders, requireUser } from '../_shared/auth.ts'

const FROM =
  Deno.env.get('ANNOUNCEMENT_FROM') ??
  Deno.env.get('DIGEST_FROM') ??
  'M&J Wilkow <onboarding@resend.dev>'
const WILKOW = '#466371', MIST = '#8fa2ad'
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const MAX_RECIPIENTS = 500
const BATCH = 100                    // Resend batch endpoint limit

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

interface Recipient {
  email: string
  name: string | null
  tenantName: string | null
  tenantId: string | null
  source: string
}

function bodyHtml(propertyName: string, subject: string, message: string, senderName: string, senderEmail: string | null): string {
  const paragraphs = message
    .split(/\n{2,}/)
    .map(p => `<p style="font-size:14px;line-height:1.55;margin:0 0 14px;">${esc(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('')
  return `<div style="font-family:Georgia,'Times New Roman',serif;max-width:620px;margin:0 auto;padding:24px;color:#1c2b33;">
    <div style="border-bottom:2px solid ${WILKOW};padding-bottom:12px;margin-bottom:18px;">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.26em;text-transform:uppercase;color:${MIST};">M&amp;J Wilkow · Tenant Announcement${propertyName ? ` · ${esc(propertyName)}` : ''}</div>
      <div style="font-size:20px;font-weight:600;color:#1c2b33;margin-top:4px;">${esc(subject)}</div>
    </div>
    ${paragraphs}
    <p style="font-size:14px;line-height:1.5;margin:18px 0 0;">${esc(senderName)}<br>M&amp;J Wilkow Properties, LLC${senderEmail ? `<br><a href="mailto:${esc(senderEmail)}" style="color:${WILKOW};">${esc(senderEmail)}</a>` : ''}</p>
    <p style="font-size:10.5px;color:#9aa8ae;margin-top:22px;font-family:Arial,sans-serif;">This announcement was sent to tenants of ${esc(propertyName || 'your property')} by the property management team. Please reply with any questions.</p>
  </div>`
}

serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const caller = await requireUser(req, sb)

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const propertyId = String(body.propertyId ?? '').trim()
    const propertyName = String(body.propertyName ?? '').trim()
    const subject = String(body.subject ?? '').trim()
    const message = String(body.message ?? '').trim()
    const recipientMode = body.recipientMode === 'all' ? 'all' : 'selected'
    const ccSender = body.ccSender === true

    if (!propertyId) throw new AuthError('propertyId is required', 400)
    if (!canWriteProperty(caller, propertyId)) throw new AuthError('No write access to this property', 403)   // WRITE gate (audit S2): this endpoint mutates state / spends AI credits
    if (!subject) throw new AuthError('Subject is required', 400)
    if (!message) throw new AuthError('Message is required', 400)

    const raw = Array.isArray(body.recipients) ? body.recipients : []
    const seen = new Set<string>()
    const recipients: Recipient[] = []
    for (const r of raw) {
      const email = String(r?.email ?? '').trim().toLowerCase()
      if (!EMAIL_RE.test(email) || seen.has(email)) continue
      seen.add(email)
      recipients.push({
        email,
        name: r?.name ? String(r.name) : null,
        tenantName: r?.tenantName ? String(r.tenantName) : null,
        tenantId: r?.tenantId ? String(r.tenantId) : null,
        source: r?.source ? String(r.source) : 'manual',
      })
    }
    if (!recipients.length) throw new AuthError('At least one valid recipient email is required', 400)
    if (recipients.length > MAX_RECIPIENTS) throw new AuthError(`Too many recipients (max ${MAX_RECIPIENTS})`, 400)

    // RECIPIENT VALIDATION (review #9): every recipient must be a known tenant
    // contact for THIS property. The server resolves the allowed set independently
    // (the same sources the picker uses: tenant_contacts + active work-order portal
    // users) rather than trusting the caller-supplied list — so the endpoint can't
    // be used as a general mass-email relay to arbitrary addresses. Fail closed
    // and name the offenders rather than silently dropping them.
    const [tcRes, puRes] = await Promise.all([
      sb.from('tenant_contacts').select('email').eq('property_id', propertyId).not('email', 'is', null),
      sb.from('work_order_portal_users').select('email').eq('property_id', propertyId).eq('is_active', true),
    ])
    if (tcRes.error) throw new Error('recipient allowlist load failed: ' + tcRes.error.message)
    if (puRes.error) throw new Error('recipient allowlist load failed: ' + puRes.error.message)
    const allowed = new Set<string>()
    for (const row of [...(tcRes.data ?? []), ...(puRes.data ?? [])] as Array<{ email: string | null }>) {
      const e = String(row.email ?? '').trim().toLowerCase()
      if (e) allowed.add(e)
    }
    const rejected = recipients.filter(r => !allowed.has(r.email))
    if (rejected.length) {
      const sample = rejected.slice(0, 5).map(r => r.email).join(', ')
      throw new AuthError(
        `${rejected.length} recipient(s) are not tenant contacts on file for this property and were not sent to: ${sample}${rejected.length > 5 ? '…' : ''}. Add them under Contacts first.`,
        400,
      )
    }

    const RESEND = Deno.env.get('RESEND_API_KEY')
    if (!RESEND) throw new Error('RESEND_API_KEY not set — add it as a function secret to enable sending')

    // Sender display name from the users row (fall back to the email local part).
    const { data: prof } = await sb.from('users').select('full_name').eq('id', caller.id).maybeSingle()
    const senderName = (prof?.full_name as string | null) ?? caller.email?.split('@')[0] ?? 'Property Management'

    const html = bodyHtml(propertyName, subject, message, senderName, caller.email)
    const fullSubject = propertyName ? `${propertyName} — ${subject}` : subject

    // One personal email per recipient, sent in batch chunks. A failed chunk
    // marks only its own recipients failed; the rest still go out.
    const results: { r: Recipient; ok: boolean; error: string | null }[] = []
    for (let i = 0; i < recipients.length; i += BATCH) {
      const chunk = recipients.slice(i, i + BATCH)
      const payload = chunk.map(r => ({
        from: FROM,
        to: [r.email],
        reply_to: caller.email ?? undefined,
        subject: fullSubject,
        html,
      }))
      try {
        const res = await fetch('https://api.resend.com/emails/batch', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const resBody = await res.json().catch(() => ({}))
        if (!res.ok) {
          const msg = `Resend rejected: ${JSON.stringify(resBody).slice(0, 200)}`
          for (const r of chunk) results.push({ r, ok: false, error: msg })
        } else {
          for (const r of chunk) results.push({ r, ok: true, error: null })
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        for (const r of chunk) results.push({ r, ok: false, error: msg })
      }
    }

    // Courtesy copy to the sender (best-effort; not part of the audit counts).
    if (ccSender && caller.email) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM, to: [caller.email],
          subject: `[Copy] ${fullSubject}`,
          html: `<p style="font-family:Arial,sans-serif;font-size:12px;color:#666;">Copy of the announcement you sent to ${results.filter(x => x.ok).length} recipient(s).</p>${html}`,
        }),
      }).catch(() => {})
    }

    const sentCount = results.filter(x => x.ok).length
    const failedCount = results.length - sentCount
    const status = sentCount === 0 ? 'failed' : failedCount > 0 ? 'partial' : 'sent'

    // Audit trail (service role; tables are read-only for staff).
    const { data: ann, error: annErr } = await sb
      .from('tenant_announcements')
      .insert({
        property_id: propertyId,
        subject,
        body: message,
        sent_by: caller.id === 'service' ? null : caller.id,
        sent_by_name: senderName,
        recipient_mode: recipientMode,
        status,
        sent_count: sentCount,
        failed_count: failedCount,
      })
      .select('id')
      .single()
    if (annErr) throw new Error(`Announcement sent (${sentCount}/${results.length}) but audit insert failed: ${annErr.message}`)

    const { error: recErr } = await sb.from('tenant_announcement_recipients').insert(
      results.map(({ r, ok, error }) => ({
        announcement_id: ann.id,
        tenant_id: r.tenantId,
        tenant_name: r.tenantName,
        contact_name: r.name,
        email: r.email,
        source: r.source,
        status: ok ? 'sent' : 'failed',
        error,
      })),
    )
    if (recErr) console.error('recipient audit insert failed:', recErr.message)

    return new Response(
      JSON.stringify({ id: ann.id, status, sent: sentCount, failed: failedCount }),
      { headers: { ...cors, 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    const status = err instanceof AuthError ? err.status : 500
    const msg = err instanceof Error ? err.message : String(err)
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
