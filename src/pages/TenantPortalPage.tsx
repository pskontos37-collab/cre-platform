import { CSSProperties, FormEvent, useCallback, useEffect, useState } from 'react'
import { useIsPhone } from '../hooks/useMediaQuery'
import { BrandMark, BrandWordmark } from '../components/ui/BrandMark'
import {
  PortalProfile, PortalOrder, PortalComment, PortalPhoto,
  getPortalToken, getCachedProfile, portalSignOut, portalLogin, portalChangePassword,
  portalOrders, portalOrderDetail, portalCreateOrder, portalAddComment,
  fileToPhotoPayload, PortalAuthExpired,
} from '../lib/portalApi'
import {
  WO_CATEGORIES, WO_PRIORITIES, OPEN_STATUSES,
  categoryIcon, categoryLabel, statusMeta, woNumber,
} from '../lib/workOrderMeta'

// Tenant work-order portal (route /portal). Chrome-less and mobile-first, like
// /inspect — but with its OWN login: portal users are rows in
// work_order_portal_users, not Supabase auth users, and every call goes
// through the work-orders edge function (see src/lib/portalApi.ts).

type View =
  | { kind: 'list' }
  | { kind: 'detail'; id: string }
  | { kind: 'new' }
  | { kind: 'done'; wo: number }

const inputStyle: CSSProperties = {
  width: '100%', padding: '11px 12px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'var(--bg)', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box',
}
const labelStyle: CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
  textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 5,
}
const primaryBtn: CSSProperties = {
  padding: '11px 18px', borderRadius: 8, border: 'none', background: 'var(--accent)',
  color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer',
}
const ghostBtn: CSSProperties = {
  padding: '10px 16px', borderRadius: 8, border: '1px solid var(--border)',
  background: 'transparent', color: 'var(--text-muted)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
}

export function TenantPortalPage() {
  const isPhone = useIsPhone()
  const [profile, setProfile] = useState<PortalProfile | null>(() =>
    getPortalToken() ? getCachedProfile() : null)
  const [view, setView] = useState<View>({ kind: 'list' })

  const signOut = useCallback(() => {
    portalSignOut()
    setProfile(null)
    setView({ kind: 'list' })
  }, [])

  // Any expired-session error anywhere drops back to the login screen.
  const guard = useCallback(<T,>(p: Promise<T>): Promise<T> =>
    p.catch(err => {
      if (err instanceof PortalAuthExpired) { setProfile(null); setView({ kind: 'list' }) }
      throw err
    }), [])

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: isPhone ? '10px 14px' : '12px 20px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface)', position: 'sticky', top: 0, zIndex: 30,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <BrandMark size={30} />
          {!isPhone && <BrandWordmark size={13} />}
          <span style={{
            fontSize: 13, fontWeight: 700, color: 'var(--text)',
            borderLeft: isPhone ? undefined : '1px solid var(--border-2)', paddingLeft: isPhone ? 0 : 10,
          }}>
            Tenant Service Portal
          </span>
        </div>
        {profile && (
          <button onClick={signOut} style={{ fontSize: 11.5, color: 'var(--text-faint)', background: 'none', border: 'none', cursor: 'pointer' }}>
            Sign out
          </button>
        )}
      </div>

      <div style={{ maxWidth: 760, margin: '0 auto', padding: isPhone ? '16px 14px 40px' : '26px 20px 60px' }}>
        {!profile ? (
          <LoginCard onSignedIn={setProfile} />
        ) : profile.must_change_password ? (
          <ChangePasswordCard
            forced
            onDone={() => setProfile({ ...profile, must_change_password: false })}
            guard={guard}
          />
        ) : view.kind === 'new' ? (
          <NewRequestForm
            profile={profile}
            guard={guard}
            onCancel={() => setView({ kind: 'list' })}
            onCreated={wo => setView({ kind: 'done', wo })}
          />
        ) : view.kind === 'done' ? (
          <SubmittedCard wo={view.wo} onBack={() => setView({ kind: 'list' })} />
        ) : view.kind === 'detail' ? (
          <OrderDetail id={view.id} guard={guard} onBack={() => setView({ kind: 'list' })} />
        ) : (
          <OrderList profile={profile} guard={guard}
            onOpen={id => setView({ kind: 'detail', id })}
            onNew={() => setView({ kind: 'new' })} />
        )}
      </div>
    </div>
  )
}

// ── Login ─────────────────────────────────────────────────────────────────────

function LoginCard({ onSignedIn }: { onSignedIn: (p: PortalProfile) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      onSignedIn(await portalLogin(email, password))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: '8vh auto 0' }}>
      <div style={{ textAlign: 'center', marginBottom: 22 }}>
        <div style={{ fontSize: 21, fontWeight: 700 }}>Tenant sign in</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>
          Submit and track maintenance requests for your space.
        </div>
      </div>
      <form onSubmit={submit} style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
        padding: 20, display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        <div>
          <label style={labelStyle}>Email</label>
          <input style={inputStyle} type="email" autoComplete="email" value={email}
            onChange={e => setEmail(e.target.value)} required />
        </div>
        <div>
          <label style={labelStyle}>Password</label>
          <input style={inputStyle} type="password" autoComplete="current-password" value={password}
            onChange={e => setPassword(e.target.value)} required />
        </div>
        {error && <div style={{ fontSize: 12.5, color: 'var(--red)' }}>{error}</div>}
        <button type="submit" disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div style={{ fontSize: 11.5, color: 'var(--text-faint)', textAlign: 'center' }}>
          Trouble signing in? Contact your property management office.
        </div>
      </form>
    </div>
  )
}

// ── Forced / voluntary password change ───────────────────────────────────────

function ChangePasswordCard({ forced, onDone, guard }: {
  forced?: boolean
  onDone: () => void
  guard: <T>(p: Promise<T>) => Promise<T>
}) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (next !== confirm) { setError('New passwords do not match'); return }
    setBusy(true); setError(null)
    try {
      await guard(portalChangePassword(current, next))
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ maxWidth: 400, margin: '6vh auto 0' }}>
      <div style={{ fontSize: 19, fontWeight: 700, marginBottom: 4 }}>
        {forced ? 'Set a new password' : 'Change password'}
      </div>
      {forced && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 16 }}>
          Your account was set up with a temporary password. Choose your own to continue.
        </div>
      )}
      <form onSubmit={submit} style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
        padding: 20, display: 'flex', flexDirection: 'column', gap: 14, marginTop: forced ? 0 : 14,
      }}>
        <div>
          <label style={labelStyle}>Current (temporary) password</label>
          <input style={inputStyle} type="password" autoComplete="current-password" value={current}
            onChange={e => setCurrent(e.target.value)} required />
        </div>
        <div>
          <label style={labelStyle}>New password (8+ characters)</label>
          <input style={inputStyle} type="password" autoComplete="new-password" value={next}
            onChange={e => setNext(e.target.value)} minLength={8} required />
        </div>
        <div>
          <label style={labelStyle}>Confirm new password</label>
          <input style={inputStyle} type="password" autoComplete="new-password" value={confirm}
            onChange={e => setConfirm(e.target.value)} minLength={8} required />
        </div>
        {error && <div style={{ fontSize: 12.5, color: 'var(--red)' }}>{error}</div>}
        <button type="submit" disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </div>
  )
}

// ── Order list ───────────────────────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  const meta = statusMeta(status)
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase',
      color: meta.color, border: `1px solid ${meta.color}`, borderRadius: 999,
      padding: '2px 9px', whiteSpace: 'nowrap',
    }}>
      {meta.tenantLabel}
    </span>
  )
}

function OrderList({ profile, guard, onOpen, onNew }: {
  profile: PortalProfile
  guard: <T>(p: Promise<T>) => Promise<T>
  onOpen: (id: string) => void
  onNew: () => void
}) {
  const [orders, setOrders] = useState<PortalOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    guard(portalOrders()).then(setOrders)
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [guard])

  const open = (orders ?? []).filter(o => OPEN_STATUSES.includes(o.status))
  const closed = (orders ?? []).filter(o => !OPEN_STATUSES.includes(o.status))

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-faint)' }}>
            {profile.property_name ?? 'Your property'}{profile.unit_label ? ` · ${profile.unit_label}` : ''}
          </div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{profile.tenant_name}</div>
        </div>
        <button onClick={onNew} style={{ ...primaryBtn, whiteSpace: 'nowrap' }}>+ New request</button>
      </div>

      {error && <div style={{ fontSize: 12.5, color: 'var(--red)', marginBottom: 12 }}>{error}</div>}
      {orders === null && !error && <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>Loading your requests…</div>}
      {orders !== null && orders.length === 0 && (
        <div style={{
          border: '1px dashed var(--border)', borderRadius: 12, padding: '34px 20px',
          textAlign: 'center', color: 'var(--text-muted)', fontSize: 13.5,
        }}>
          No maintenance requests yet. Tap <b>New request</b> to submit your first one.
        </div>
      )}

      {open.length > 0 && <Section title="Open requests" orders={open} onOpen={onOpen} />}
      {closed.length > 0 && <Section title="Completed & closed" orders={closed} onOpen={onOpen} faded />}
    </div>
  )
}

function Section({ title, orders, onOpen, faded }: {
  title: string; orders: PortalOrder[]; onOpen: (id: string) => void; faded?: boolean
}) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {orders.map(o => (
          <button key={o.id} onClick={() => onOpen(o.id)} style={{
            textAlign: 'left', padding: '13px 14px', borderRadius: 10, cursor: 'pointer',
            border: '1px solid var(--border)', background: 'var(--surface)',
            display: 'flex', alignItems: 'center', gap: 12, opacity: faded ? 0.75 : 1,
          }}>
            <span style={{ fontSize: 20 }}>{categoryIcon(o.category)}</span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {o.title}
              </span>
              <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>
                {woNumber(o.wo_number)} · {categoryLabel(o.category)}
                {o.location_type === 'common_area' ? ' · Common area' : ''} · {new Date(o.created_at).toLocaleDateString()}
              </span>
            </span>
            <StatusChip status={o.status} />
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Order detail + thread ────────────────────────────────────────────────────

function OrderDetail({ id, guard, onBack }: {
  id: string
  guard: <T>(p: Promise<T>) => Promise<T>
  onBack: () => void
}) {
  const [order, setOrder] = useState<PortalOrder | null>(null)
  const [comments, setComments] = useState<PortalComment[]>([])
  const [photos, setPhotos] = useState<PortalPhoto[]>([])
  const [error, setError] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    guard(portalOrderDetail(id))
      .then(r => { setOrder(r.order); setComments(r.comments); setPhotos(r.photos) })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [id, guard])

  async function send(e: FormEvent) {
    e.preventDefault()
    if (!reply.trim()) return
    setSending(true)
    try {
      const c = await guard(portalAddComment(id, reply.trim()))
      setComments(prev => [...prev, c])
      setReply('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div>
      <button onClick={onBack} style={{ ...ghostBtn, padding: '6px 12px', marginBottom: 14 }}>← All requests</button>
      {error && <div style={{ fontSize: 12.5, color: 'var(--red)', marginBottom: 12 }}>{error}</div>}
      {!order && !error && <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>Loading…</div>}
      {order && (
        <>
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
              <div>
                <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{woNumber(order.wo_number)}</div>
                <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{order.title}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 4 }}>
                  {categoryIcon(order.category)} {categoryLabel(order.category)}
                  {order.location_type === 'common_area'
                    ? ` · Common area${order.location_detail ? ` (${order.location_detail})` : ''}`
                    : order.unit_label ? ` · ${order.unit_label}` : ''}
                  {' '}· submitted {new Date(order.created_at).toLocaleDateString()}
                </div>
                {order.assigned_vendor && !['completed', 'cancelled'].includes(order.status) && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
                    🔧 Contractor assigned: <b>{order.assigned_vendor}</b>
                  </div>
                )}
              </div>
              <StatusChip status={order.status} />
            </div>
            {order.description && (
              <div style={{ fontSize: 13.5, color: 'var(--text)', marginTop: 12, whiteSpace: 'pre-wrap' }}>
                {order.description}
              </div>
            )}
            {order.status === 'completed' && order.resolution_notes && (
              <div style={{
                marginTop: 12, padding: '10px 12px', borderRadius: 8,
                border: '1px solid var(--green)', fontSize: 13, color: 'var(--text)',
              }}>
                <b>Resolution:</b> {order.resolution_notes}
              </div>
            )}
            {photos.length > 0 && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                {photos.map(p => (
                  <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                    <img src={p.url} alt={p.caption ?? 'photo'} style={{
                      width: 86, height: 86, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)',
                    }} />
                  </a>
                ))}
              </div>
            )}
          </div>

          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-faint)', margin: '18px 0 8px' }}>
            Updates
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {comments.length === 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>No updates yet — the management team will respond here.</div>
            )}
            {comments.map(c => (
              <div key={c.id} style={{
                padding: '10px 12px', borderRadius: 10, fontSize: 13.5,
                background: c.author_kind === 'staff' ? 'var(--surface)' : 'transparent',
                border: '1px solid var(--border)',
              }}>
                <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 3 }}>
                  {c.author_kind === 'staff' ? `${c.author_name ?? 'Property management'} · Management` : (c.author_name ?? 'You')}
                  {' · '}{new Date(c.created_at).toLocaleString()}
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
              </div>
            ))}
          </div>

          {!['completed', 'cancelled'].includes(order.status) && (
            <form onSubmit={send} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <input style={{ ...inputStyle, flex: 1 }} placeholder="Add a comment or more detail…"
                value={reply} onChange={e => setReply(e.target.value)} />
              <button type="submit" disabled={sending || !reply.trim()}
                style={{ ...primaryBtn, opacity: sending || !reply.trim() ? 0.5 : 1 }}>
                Send
              </button>
            </form>
          )}
        </>
      )}
    </div>
  )
}

// ── New request ──────────────────────────────────────────────────────────────

function NewRequestForm({ profile, guard, onCancel, onCreated }: {
  profile: PortalProfile
  guard: <T>(p: Promise<T>) => Promise<T>
  onCancel: () => void
  onCreated: (woNum: number) => void
}) {
  const isPhone = useIsPhone()
  const [category, setCategory] = useState('')
  const [priority, setPriority] = useState('normal')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [unit, setUnit] = useState(profile.unit_label ?? '')
  const [locationType, setLocationType] = useState<'unit' | 'common_area'>('unit')
  const [locationDetail, setLocationDetail] = useState('')
  const [phone, setPhone] = useState(profile.phone ?? '')
  const [permission, setPermission] = useState(true)
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function pickFiles(list: FileList | null) {
    if (!list) return
    const next = [...files]
    for (const f of Array.from(list)) {
      if (!f.type.startsWith('image/')) continue
      if (f.size > 5 * 1024 * 1024) { setError(`${f.name} is over the 5 MB photo limit`); continue }
      if (next.length < 5) next.push(f)
    }
    setFiles(next)
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!category) { setError('Pick a category for the issue'); return }
    setBusy(true); setError(null)
    try {
      const photos = await Promise.all(files.map(fileToPhotoPayload))
      const { order } = await guard(portalCreateOrder({
        category, priority,
        title: title.trim(),
        description: description.trim(),
        unit_label: unit.trim() || undefined,
        location_type: locationType,
        location_detail: locationType === 'common_area' ? locationDetail.trim() || undefined : undefined,
        contact_phone: phone.trim() || undefined,
        permission_to_enter: permission,
        photos,
      }))
      onCreated(order.wo_number)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 19, fontWeight: 700 }}>New maintenance request</div>
        <button type="button" onClick={onCancel} style={{ ...ghostBtn, padding: '6px 12px' }}>Cancel</button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={labelStyle}>Where is the issue?</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {([
              { value: 'unit' as const, label: 'My space', hint: profile.unit_label ?? 'Inside your suite' },
              { value: 'common_area' as const, label: 'Common area', hint: 'Parking lot, corridors, restrooms, exterior…' },
            ]).map(opt => (
              <button key={opt.value} type="button" onClick={() => setLocationType(opt.value)} style={{
                padding: '11px 12px', borderRadius: 9, cursor: 'pointer', textAlign: 'left',
                border: `1px solid ${locationType === opt.value ? 'var(--accent)' : 'var(--border)'}`,
                background: locationType === opt.value ? 'var(--surface)' : 'transparent',
              }}>
                <span style={{ display: 'block', fontSize: 13.5, fontWeight: 700, color: locationType === opt.value ? 'var(--text)' : 'var(--text-muted)' }}>
                  {opt.label}
                </span>
                <span style={{ display: 'block', fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>{opt.hint}</span>
              </button>
            ))}
          </div>
          {locationType === 'common_area' && (
            <input style={{ ...inputStyle, marginTop: 8 }} value={locationDetail}
              onChange={e => setLocationDetail(e.target.value)} maxLength={300}
              placeholder="Where exactly? e.g. light pole out near the main entrance" />
          )}
        </div>

        <div>
          <label style={labelStyle}>What kind of issue is it?</label>
          <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr 1fr' : 'repeat(3, 1fr)', gap: 8 }}>
            {WO_CATEGORIES.map(c => (
              <button key={c.value} type="button" onClick={() => setCategory(c.value)} style={{
                padding: '10px 8px', borderRadius: 9, cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
                border: `1px solid ${category === c.value ? 'var(--accent)' : 'var(--border)'}`,
                background: category === c.value ? 'var(--surface)' : 'transparent',
                color: category === c.value ? 'var(--text)' : 'var(--text-muted)',
                display: 'flex', alignItems: 'center', gap: 7, textAlign: 'left',
              }}>
                <span>{c.icon}</span><span>{c.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={labelStyle}>Urgency</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {WO_PRIORITIES.map(p => (
              <button key={p.value} type="button" onClick={() => setPriority(p.value)} style={{
                padding: '8px 16px', borderRadius: 999, cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
                border: `1px solid ${priority === p.value ? 'var(--accent)' : 'var(--border)'}`,
                background: priority === p.value ? 'var(--surface)' : 'transparent',
                color: p.value === 'emergency' ? 'var(--red)' : priority === p.value ? 'var(--text)' : 'var(--text-muted)',
              }}>
                {p.label}
              </button>
            ))}
          </div>
          {priority === 'emergency' && (
            <div style={{ fontSize: 12.5, color: 'var(--red)', marginTop: 8 }}>
              For fire, flooding, gas odors or anything life-threatening, call 911 and then your
              property management emergency line before submitting this request.
            </div>
          )}
        </div>

        <div>
          <label style={labelStyle}>Short title</label>
          <input style={inputStyle} value={title} onChange={e => setTitle(e.target.value)}
            placeholder="e.g. AC not cooling in back office" maxLength={140} required />
        </div>

        <div>
          <label style={labelStyle}>Describe the problem</label>
          <textarea style={{ ...inputStyle, minHeight: 110, resize: 'vertical' }}
            value={description} onChange={e => setDescription(e.target.value)}
            placeholder="Where is it, when did it start, anything already tried…" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : '1fr 1fr', gap: 12 }}>
          {locationType === 'unit' && (
            <div>
              <label style={labelStyle}>Suite / unit</label>
              <input style={inputStyle} value={unit} onChange={e => setUnit(e.target.value)} placeholder="e.g. Suite 210" />
            </div>
          )}
          <div>
            <label style={labelStyle}>Contact phone</label>
            <input style={inputStyle} type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="(555) 555-5555" />
          </div>
        </div>

        {locationType === 'unit' && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5, cursor: 'pointer' }}>
            <input type="checkbox" checked={permission} onChange={e => setPermission(e.target.checked)} />
            Maintenance may enter the space if no one is present
          </label>
        )}

        <div>
          <label style={labelStyle}>Photos (optional, up to 5)</label>
          <input type="file" accept="image/*" multiple onChange={e => { pickFiles(e.target.files); e.target.value = '' }}
            style={{ fontSize: 13 }} />
          {files.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
              {files.map((f, i) => (
                <div key={i} style={{ position: 'relative' }}>
                  <img src={URL.createObjectURL(f)} alt={f.name} style={{
                    width: 74, height: 74, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)',
                  }} />
                  <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} style={{
                    position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 999,
                    border: 'none', background: 'var(--red)', color: '#fff', fontSize: 11, cursor: 'pointer', lineHeight: '20px',
                  }}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <div style={{ fontSize: 12.5, color: 'var(--red)' }}>{error}</div>}
        <button type="submit" disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1, padding: '13px 18px' }}>
          {busy ? 'Submitting…' : 'Submit request'}
        </button>
      </div>
    </form>
  )
}

function SubmittedCard({ wo, onBack }: { wo: number; onBack: () => void }) {
  return (
    <div style={{ maxWidth: 420, margin: '8vh auto 0', textAlign: 'center' }}>
      <div style={{ fontSize: 44, marginBottom: 10 }}>✅</div>
      <div style={{ fontSize: 20, fontWeight: 700 }}>Request submitted</div>
      <div style={{ fontSize: 14, color: 'var(--text-muted)', marginTop: 8 }}>
        Your request <b style={{ color: 'var(--text)' }}>{woNumber(wo)}</b> has been sent to the
        property management team. You can follow updates and add comments from your request list.
      </div>
      <button onClick={onBack} style={{ ...primaryBtn, marginTop: 20 }}>Back to my requests</button>
    </div>
  )
}
