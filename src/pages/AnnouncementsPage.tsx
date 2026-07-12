import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { useProperties } from '../hooks/useProperties'
import { useFilteredPropertyIds, usePropertyNameMap } from '../hooks/useFilteredPropertyIds'
import {
  useAnnouncementRecipients, useAnnouncementHistory,
  sendAnnouncement, fetchAnnouncementRecipients,
  type AnnouncementRecipient, type Announcement, type AnnouncementRecipientRow,
} from '../hooks/useAnnouncements'
import { EmptyState } from '../components/ui/EmptyState'

// ── M&J Wilkow corporate palette — matches the other ops pages ──────────────
const WILKOW      = '#466371'
const WILKOW_MIST = '#8fa2ad'
const SERIF       = "'Frank Ruhl Libre', 'Cinzel', Georgia, serif"

const card: CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 10, padding: 18,
}
const label: CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
  textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6,
}
const input: CSSProperties = {
  width: '100%', fontSize: 13, padding: '8px 10px', borderRadius: 7,
  border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)',
  boxSizing: 'border-box',
}

const STATUS_STYLE: Record<Announcement['status'], { label: string; color: string }> = {
  sent:    { label: 'Sent',           color: 'var(--green)' },
  partial: { label: 'Partly failed',  color: 'var(--amber)' },
  failed:  { label: 'Failed',         color: 'var(--red)' },
}

export function AnnouncementsPage() {
  const { data: properties } = useProperties()
  const propertyIds = useFilteredPropertyIds(properties ?? null)
  const propertyNames = usePropertyNameMap(properties ?? null)

  const visibleProps = useMemo(
    () => (properties ?? []).filter(p => propertyIds.includes(p.id)).sort((a, b) => a.name.localeCompare(b.name)),
    [properties, propertyIds],
  )

  const [propertyId, setPropertyId] = useState<string>('')
  // Keep the selection valid as the header filter changes; auto-pick a sole property.
  useEffect(() => {
    if (propertyId && !propertyIds.includes(propertyId)) setPropertyId('')
    if (!propertyId && visibleProps.length === 1) setPropertyId(visibleProps[0].id)
  }, [propertyId, propertyIds, visibleProps])

  const { data: pool, loading: poolLoading } = useAnnouncementRecipients(propertyId || null)
  const recipients = pool?.recipients ?? []
  const gap = pool?.tenantsWithoutEmail ?? []

  const [mode, setMode] = useState<'all' | 'selected'>('all')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [ccSender, setCcSender] = useState(true)
  const [sending, setSending] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  // Reset the picker when the property changes.
  useEffect(() => { setPicked(new Set()); setMode('all'); setMsg(null) }, [propertyId])

  const effective = mode === 'all' ? recipients : recipients.filter(r => picked.has(r.key))

  const history = useAnnouncementHistory(propertyIds)

  function togglePick(key: string) {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  async function onSend() {
    if (sending) return
    setMsg(null)
    if (!propertyId) { setMsg({ kind: 'err', text: 'Pick a property first.' }); return }
    if (!subject.trim()) { setMsg({ kind: 'err', text: 'Enter a subject.' }); return }
    if (!message.trim()) { setMsg({ kind: 'err', text: 'Enter a message.' }); return }
    if (!effective.length) { setMsg({ kind: 'err', text: 'No recipients selected — the announcement would go to no one.' }); return }
    const pName = propertyNames[propertyId] ?? ''
    if (!confirm(`Send "${subject.trim()}" to ${effective.length} recipient${effective.length === 1 ? '' : 's'} at ${pName}?`)) return
    setSending(true)
    try {
      const res = await sendAnnouncement({
        propertyId, propertyName: pName,
        subject: subject.trim(), message: message.trim(),
        recipientMode: mode, recipients: effective, ccSender,
      })
      setMsg(res.failed > 0
        ? { kind: 'err', text: `Sent to ${res.sent} recipient(s); ${res.failed} failed — see the history below for details.` }
        : { kind: 'ok', text: `Announcement sent to ${res.sent} recipient(s).` })
      if (res.sent > 0) { setSubject(''); setMessage(''); setPicked(new Set()); setMode('all') }
      history.refetch()
    } catch (err) {
      setMsg({ kind: 'err', text: `Send failed: ${err instanceof Error ? err.message : String(err)}` })
    } finally { setSending(false) }
  }

  // recipients grouped by tenant for the picker
  const byTenant = useMemo(() => {
    const m = new Map<string, AnnouncementRecipient[]>()
    for (const r of recipients) {
      const list = m.get(r.tenantName) ?? []
      list.push(r)
      m.set(r.tenantName, list)
    }
    return Array.from(m.entries())
  }, [recipients])

  return (
    <div style={{ padding: '26px 32px 48px', maxWidth: 1080 }}>
      <div style={{ marginBottom: 4 }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.28em', textTransform: 'uppercase', color: WILKOW_MIST, marginBottom: 6 }}>
          M&amp;J Wilkow · Tenant Communications
        </div>
        <div style={{ fontFamily: SERIF, fontSize: 27, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--text)', lineHeight: 1.15 }}>
          Announcements
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '8px 0 0', maxWidth: 720 }}>
          Email an announcement to the tenants of a property — everyone, or a selected subset. Each tenant
          receives an individual email (addresses are never shared) and replies go straight to you.
          Recipient emails come from the <Link to="/contacts" style={{ color: WILKOW }}>Contacts directory</Link> and
          active work-order portal logins.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 20, alignItems: 'start', marginTop: 20 }}>
        {/* ── LEFT: compose ── */}
        <div style={card}>
          <div style={{ marginBottom: 14 }}>
            <label style={label}>Property</label>
            <select value={propertyId} onChange={e => setPropertyId(e.target.value)} style={input}>
              <option value="">Select a property…</option>
              {visibleProps.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={label}>Subject</label>
            <input
              style={input} value={subject} maxLength={200}
              onChange={e => setSubject(e.target.value)}
              placeholder="e.g. Parking lot repaving — March 18–20"
            />
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={label}>Message</label>
            <textarea
              style={{ ...input, minHeight: 180, resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}
              value={message} onChange={e => setMessage(e.target.value)}
              placeholder={'Write the announcement in plain text. Blank lines start a new paragraph.\n\nIt is sent on the standard M&J Wilkow letterhead with your name and email in the signature.'}
            />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text)', marginBottom: 16, cursor: 'pointer' }}>
            <input type="checkbox" checked={ccSender} onChange={e => setCcSender(e.target.checked)} />
            Email me a copy
          </label>
          <button
            onClick={onSend}
            disabled={sending || !propertyId}
            style={{
              fontSize: 13.5, fontWeight: 700, padding: '10px 22px', borderRadius: 8, border: 'none',
              cursor: sending || !propertyId ? 'default' : 'pointer',
              background: sending || !propertyId ? 'var(--border)' : WILKOW,
              color: sending || !propertyId ? 'var(--text-muted)' : '#fff',
            }}
          >
            {sending ? 'Sending…' : `📣 Send to ${effective.length} recipient${effective.length === 1 ? '' : 's'}`}
          </button>
          {msg && (
            <div style={{ marginTop: 12, fontSize: 13, color: msg.kind === 'ok' ? 'var(--green)' : 'var(--red)' }}>
              {msg.text}
            </div>
          )}
        </div>

        {/* ── RIGHT: recipients ── */}
        <div style={card}>
          <label style={label}>Recipients</label>
          {!propertyId ? (
            <div style={{ fontSize: 13, color: 'var(--text-faint)', padding: '14px 0' }}>Pick a property to load its tenant recipients.</div>
          ) : poolLoading ? (
            <div style={{ fontSize: 13, color: 'var(--text-faint)', padding: '14px 0' }}>Loading recipients…</div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                {(['all', 'selected'] as const).map(m => (
                  <button
                    key={m} onClick={() => setMode(m)}
                    style={{
                      fontSize: 12.5, fontWeight: 650, padding: '6px 14px', borderRadius: 999, cursor: 'pointer',
                      border: `1px solid ${mode === m ? WILKOW : 'var(--border)'}`,
                      background: mode === m ? WILKOW : 'transparent',
                      color: mode === m ? '#fff' : 'var(--text-muted)',
                    }}
                  >
                    {m === 'all' ? `All tenants (${recipients.length})` : `Select tenants${mode === 'selected' ? ` (${picked.size})` : ''}`}
                  </button>
                ))}
              </div>
              {recipients.length === 0 ? (
                <div style={{ fontSize: 13, color: 'var(--amber)' }}>
                  No tenant emails on file for this property yet — add them in the{' '}
                  <Link to="/contacts" style={{ color: WILKOW }}>Contacts directory</Link>.
                </div>
              ) : (
                <div style={{ maxHeight: 380, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
                  {byTenant.map(([tenantName, list]) => (
                    <div key={tenantName} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
                      <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>{tenantName}</div>
                      {list.map(r => (
                        <label key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '3px 0', cursor: mode === 'selected' ? 'pointer' : 'default', color: 'var(--text-muted)' }}>
                          <input
                            type="checkbox"
                            checked={mode === 'all' || picked.has(r.key)}
                            disabled={mode === 'all'}
                            onChange={() => togglePick(r.key)}
                          />
                          <span style={{ color: 'var(--text)' }}>{r.name || r.email}</span>
                          {r.name && <span>{r.email}</span>}
                          <span style={{ fontSize: 10.5, color: 'var(--text-faint)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>{r.sourceLabel}</span>
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {gap.length > 0 && (
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--amber)', lineHeight: 1.5 }}>
                  ⚠️ {gap.length} leased tenant{gap.length === 1 ? ' has' : 's have'} no email on file and will NOT
                  receive this: {gap.slice(0, 6).join(', ')}{gap.length > 6 ? ` +${gap.length - 6} more` : ''}.{' '}
                  <Link to="/contacts" style={{ color: WILKOW }}>Add emails →</Link>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── history ── */}
      <div style={{ marginTop: 28 }}>
        <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 600, color: 'var(--text)', borderBottom: `2px solid ${WILKOW}`, paddingBottom: 8, marginBottom: 12 }}>
          Sent announcements
        </div>
        {history.loading ? (
          <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>Loading…</div>
        ) : (history.data ?? []).length === 0 ? (
          <EmptyState icon="📣" title="No announcements yet" subtitle="Announcements you send appear here with per-recipient delivery status." />
        ) : (
          (history.data ?? []).map(a => (
            <HistoryRow key={a.id} a={a} propertyName={propertyNames[a.propertyId] ?? '—'} />
          ))
        )}
      </div>
    </div>
  )
}

function HistoryRow({ a, propertyName }: { a: Announcement; propertyName: string }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<AnnouncementRecipientRow[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const st = STATUS_STYLE[a.status]

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && rows === null) {
      try { setRows(await fetchAnnouncementRecipients(a.id)) }
      catch (e) { setLoadErr(e instanceof Error ? e.message : String(e)) }
    }
  }

  return (
    <div style={{ ...card, padding: '12px 16px', marginBottom: 10 }}>
      <div onClick={toggle} style={{ display: 'flex', alignItems: 'baseline', gap: 10, cursor: 'pointer', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>{a.subject}</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{propertyName}</span>
        <span style={{ fontSize: 12, color: 'var(--text-faint)', marginLeft: 'auto' }}>
          {a.sentByName ?? '—'} · {new Date(a.createdAt).toLocaleString()} ·{' '}
          {a.recipientMode === 'all' ? 'all tenants' : 'selected'} · {a.sentCount} sent{a.failedCount ? `, ${a.failedCount} failed` : ''}
        </span>
        <span style={{ fontSize: 11.5, fontWeight: 700, color: st.color }}>{st.label}</span>
      </div>
      {open && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <div style={{ fontSize: 13, color: 'var(--text)', whiteSpace: 'pre-wrap', lineHeight: 1.55, marginBottom: 10 }}>{a.body}</div>
          {loadErr ? (
            <div style={{ fontSize: 12, color: 'var(--red)' }}>{loadErr}</div>
          ) : rows === null ? (
            <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Loading recipients…</div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 4 }}>
              {rows.map((r, i) => (
                <div key={i}>
                  {r.status === 'failed' ? '✕' : '✓'} {r.tenantName ? `${r.tenantName} — ` : ''}{r.contactName || r.email}
                  {r.contactName ? ` (${r.email})` : ''}
                  {r.error ? <span style={{ color: 'var(--red)' }}> — {r.error}</span> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
