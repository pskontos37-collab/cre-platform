// service-agreement-digest — emails a renewals digest from service_agreement_alerts.
//
// Surfaces the governing contract per vendor+category that is expiring within a
// horizon (default 90 days), soonest first, grouped by property, plus a count of
// already-expired agreements. Meant to run on a weekly pg_cron schedule so
// renewals don't lapse unnoticed; also callable ad-hoc for a test send.
//
// Auth: portfolio-wide caller only (admin / asset_manager JWT, or the service
//       role key that pg_cron sends). Mirrors the other service-role functions.
// Send: Resend HTTP API. Requires the RESEND_API_KEY function secret; from-address
//       is DIGEST_FROM (defaults to Resend's onboarding sender so a first
//       test-to-yourself works before a domain is verified).
//
// POST JSON (all optional):
//   { "dryRun": true }            -> compose + return the HTML/preview, DO NOT send
//   { "test": true, "to": "x@y" } -> send only to the given address (or caller)
//   { "horizonDays": 120 }        -> expiring window (default 90)
//   { "to": ["a@x","b@y"] }       -> explicit recipients (else DIGEST_RECIPIENTS env)
//
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY.
// Optional secrets: DIGEST_FROM, DIGEST_RECIPIENTS (comma-separated), APP_URL.

import { serve } from 'https://deno.land/std@0.208.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { AuthError, corsHeaders, requireUser } from '../_shared/auth.ts'

const APP_URL = Deno.env.get('APP_URL') ?? 'https://cre-platform-mjw2.vercel.app'
const FROM     = Deno.env.get('DIGEST_FROM') ?? 'M&J Wilkow Alerts <onboarding@resend.dev>'
const WILKOW = '#466371', MIST = '#8fa2ad'

interface AlertRow {
  id: string
  property_name: string
  vendor: string
  service_category: string
  end_date: string | null
  days_until: number | null
  is_expired: boolean
}

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

// Renders one property-grouped table (used for both the expiring and the
// recently-lapsed sections). `mode` picks the day-count phrasing/color.
function section(title: string, subtitle: string, rows: AlertRow[], mode: 'expiring' | 'lapsed'): string {
  if (!rows.length) return ''
  const byProp = new Map<string, AlertRow[]>()
  for (const r of rows) {
    const list = byProp.get(r.property_name) ?? []
    list.push(r); byProp.set(r.property_name, list)
  }
  const blocks = [...byProp.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([prop, rs]) => {
    const items = rs.map(r => {
      const d = r.days_until ?? 0
      const label = mode === 'expiring' ? `${d}d` : `${Math.abs(d)}d ago`
      const color = mode === 'lapsed' ? '#c25b52' : d <= 30 ? '#c25b52' : d <= 60 ? '#c2a35a' : MIST
      return `<tr>
        <td style="padding:6px 10px;font-variant-numeric:tabular-nums;font-weight:700;color:${color};white-space:nowrap;">${label}</td>
        <td style="padding:6px 10px;color:#1c2b33;">${esc(r.vendor)} <span style="color:${MIST};font-size:11px;">· ${esc(r.service_category)}</span></td>
        <td style="padding:6px 10px;color:#5a6b73;white-space:nowrap;">${r.end_date ? esc(fmtDate(r.end_date)) : ''}</td>
      </tr>`
    }).join('')
    return `<div style="margin:0 0 14px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:${MIST};margin:0 0 6px;">${esc(prop)}</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">${items}</table>
    </div>`
  }).join('')
  return `<div style="margin:0 0 22px;">
    <div style="font-size:13px;font-weight:700;color:#1c2b33;margin:0 0 2px;">${title}</div>
    <div style="font-size:11.5px;color:#5a6b73;margin:0 0 10px;">${subtitle}</div>
    ${blocks}
  </div>`
}

function buildHtml(expiring: AlertRow[], lapsed: AlertRow[], totalExpired: number, horizon: number, lapseWindow: number): string {
  const expBlock = expiring.length
    ? section('Expiring soon', `Renew before they lapse — next ${horizon} days, soonest first.`, expiring, 'expiring')
    : `<p style="font-size:13px;color:#5a6b73;margin:0 0 18px;">Nothing expiring in the next ${horizon} days. ✅</p>`
  const lapseBlock = section('Recently lapsed', `Ended in the last ${lapseWindow} days — a recurring service may be running without a current contract.`, lapsed, 'lapsed')
  const olderExpired = Math.max(0, totalExpired - lapsed.length)
  const olderLine = olderExpired > 0
    ? `<p style="font-size:11.5px;color:#9aa8ae;margin:4px 0 0;">Plus ${olderExpired} older expired agreement${olderExpired === 1 ? '' : 's'} on file (mostly completed one-off jobs) — <a href="${APP_URL}/services?status=expired" style="color:${MIST};">see the panel</a>.</p>`
    : ''

  return `<div style="font-family:Georgia,'Times New Roman',serif;max-width:640px;margin:0 auto;padding:24px;color:#1c2b33;">
    <div style="border-bottom:2px solid ${WILKOW};padding-bottom:12px;margin-bottom:18px;">
      <div style="font-size:10px;font-weight:600;letter-spacing:0.26em;text-transform:uppercase;color:${MIST};">M&amp;J Wilkow · Property Operations</div>
      <div style="font-size:22px;font-weight:600;color:#1c2b33;margin-top:4px;">Service Agreement Renewals</div>
      <div style="font-size:12px;color:#5a6b73;margin-top:4px;">Vendor contracts needing attention across the portfolio.</div>
    </div>
    ${expBlock}
    ${lapseBlock}
    ${olderLine}
    <p style="margin:22px 0 0;"><a href="${APP_URL}/services?status=expiring" style="display:inline-block;background:${WILKOW};color:#fff;text-decoration:none;font-family:Arial,sans-serif;font-size:13px;padding:9px 16px;border-radius:6px;">Open the Services panel →</a></p>
    <p style="font-size:10.5px;color:#9aa8ae;margin-top:18px;font-family:Arial,sans-serif;">Automated digest from the M&amp;J Wilkow asset-management platform. Data is abstracted from the executed agreements on file; verify against the source contract before acting.</p>
  </div>`
}

serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  try {
    const caller = await requireUser(req, sb)
    if (caller.access !== 'all') throw new AuthError('Digest requires portfolio-wide access', 403)

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const dryRun = body.dryRun === true
    const isTest = body.test === true
    const horizon = Number.isFinite(body.horizonDays) ? Math.max(1, Math.min(365, body.horizonDays)) : 90

    // Recipients: explicit body.to, else env list, else the caller (for tests).
    const envList = (Deno.env.get('DIGEST_RECIPIENTS') ?? '').split(',').map(s => s.trim()).filter(Boolean)
    let recipients: string[] =
      body.to ? (Array.isArray(body.to) ? body.to : [body.to])
      : isTest && caller.email ? [caller.email]
      : envList
    recipients = recipients.map(s => String(s).trim()).filter(Boolean)

    // Pull governing alerts from the canonical view.
    const { data, error } = await sb
      .from('service_agreement_alerts')
      .select('id, property_name, vendor, service_category, end_date, days_until, is_expired')
    if (error) throw new Error(`query failed: ${error.message}`)
    const rows = (data ?? []) as AlertRow[]

    // How far back a lapse still counts as "recent / actionable" (older expired
    // rows are mostly completed one-off jobs and would just be noise).
    const lapseWindow = Number.isFinite(body.lapseWindowDays) ? Math.max(1, Math.min(730, body.lapseWindowDays)) : 180

    const expiring = rows
      .filter(r => !r.is_expired && r.days_until != null && r.days_until >= 0 && r.days_until <= horizon)
      .sort((a, b) => (a.days_until ?? 0) - (b.days_until ?? 0))
    const lapsed = rows
      .filter(r => r.is_expired && r.days_until != null && r.days_until >= -lapseWindow)
      .sort((a, b) => (b.days_until ?? 0) - (a.days_until ?? 0))   // most-recent lapse first
    const totalExpired = rows.filter(r => r.is_expired).length

    const html = buildHtml(expiring, lapsed, totalExpired, horizon, lapseWindow)
    const subject = `Service Agreement Renewals — ${expiring.length} expiring, ${lapsed.length} recently lapsed`

    if (dryRun) {
      return new Response(JSON.stringify({
        dryRun: true, horizon, lapseWindow, recipients,
        expiringCount: expiring.length, lapsedCount: lapsed.length, totalExpired,
        expiring: expiring.map(r => ({ property: r.property_name, vendor: r.vendor, category: r.service_category, days: r.days_until, end: r.end_date })),
        lapsed: lapsed.map(r => ({ property: r.property_name, vendor: r.vendor, category: r.service_category, days: r.days_until, end: r.end_date })),
        subject, html,
      }, null, 2), { headers: { ...cors, 'Content-Type': 'application/json' } })
    }

    if (!recipients.length) throw new Error('No recipients — pass "to" or set DIGEST_RECIPIENTS')
    const RESEND = Deno.env.get('RESEND_API_KEY')
    if (!RESEND) throw new Error('RESEND_API_KEY not set — add it as a function secret to enable sending')

    const send = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: recipients, subject, html }),
    })
    const sendBody = await send.json().catch(() => ({}))
    const ok = send.ok

    await sb.from('service_agreement_alert_log').insert({
      recipients, horizon_days: horizon,
      expiring_count: expiring.length, expired_count: lapsed.length,
      agreement_ids: [...expiring, ...lapsed].map(r => r.id), test: isTest, ok,
      detail: ok ? (sendBody?.id ?? null) : `send failed: ${JSON.stringify(sendBody).slice(0, 400)}`,
    })

    if (!ok) throw new Error(`Resend rejected: ${JSON.stringify(sendBody).slice(0, 300)}`)
    return new Response(JSON.stringify({ sent: true, id: sendBody?.id, recipients, expiringCount: expiring.length, lapsedCount: lapsed.length }, null, 2),
      { headers: { ...cors, 'Content-Type': 'application/json' } })

  } catch (err) {
    const status = err instanceof AuthError ? err.status : 500
    const msg = err instanceof Error ? err.message : String(err)
    return new Response(JSON.stringify({ error: msg }), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  }
})
