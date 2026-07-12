import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useProperties, usePortfolios } from '../hooks/useProperties'
import {
  useUsers, useAccessTemplates, createUser, setPassword, deleteUser,
  updateUser, applyTemplate, saveTemplate, deleteTemplate, entitlementsFromTemplate,
  setUserEntitlements, type AdminUser, type NewEntitlement,
} from '../hooks/useAdmin'
import { ASSIGNABLE_PAGES } from '../lib/pages'
import { WIDGET_DEFS, DASHBOARD_SECTIONS, ROLE_PRESETS } from '../lib/dashboardWidgets'
import type { AccessTemplate, UserRole, EntitlementScope } from '../types/database'
import { WidgetSkeleton } from '../components/ui/Widget'

// ── M&J Wilkow palette (matches ReceivablesPage / ServiceAgreementsPage) ─────
const WILKOW = '#466371'
const SERIF  = "'Frank Ruhl Libre', 'Cinzel', Georgia, serif"

const ROLES: { value: UserRole; label: string; hint: string }[] = [
  { value: 'admin',            label: 'Admin',            hint: 'Full access + user management' },
  { value: 'asset_manager',    label: 'Asset Manager',    hint: 'All properties, financial & capital data' },
  { value: 'property_manager', label: 'Property Manager', hint: 'Scoped to assigned properties' },
]
const ROLE_LABEL: Record<UserRole, string> = {
  admin: 'Admin', asset_manager: 'Asset Manager', property_manager: 'Property Manager',
}

function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%'
  const buf = new Uint32Array(14)
  crypto.getRandomValues(buf)
  return Array.from(buf, n => chars[n % chars.length]).join('')
}

// ── shared bits ─────────────────────────────────────────────────────────────
const card: CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: 20,
}
const label: CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }
const input: CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border-2)',
  background: 'var(--surface-2)', color: 'var(--text)', fontSize: 13,
}
function btn(variant: 'primary' | 'ghost' | 'danger' = 'ghost'): CSSProperties {
  const base: CSSProperties = { padding: '7px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--border-2)' }
  if (variant === 'primary') return { ...base, background: WILKOW, color: '#fff', border: `1px solid ${WILKOW}` }
  if (variant === 'danger')  return { ...base, background: 'var(--red-bg)', color: 'var(--red)', border: '1px solid var(--red-border)' }
  return { ...base, background: 'var(--surface-2)', color: 'var(--text-muted)' }
}

function Toast({ msg }: { msg: { type: 'success' | 'error'; text: string } | null }) {
  if (!msg) return null
  const ok = msg.type === 'success'
  return (
    <div style={{
      padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16,
      background: ok ? 'var(--green-bg)' : 'var(--red-bg)',
      color: ok ? 'var(--green)' : 'var(--red)',
      border: `1px solid ${ok ? 'var(--green-border)' : 'var(--red-border)'}`,
    }}>{msg.text}</div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
export function AdminPage() {
  const { appUser } = useAuth()
  const [tab, setTab] = useState<'users' | 'templates'>('users')

  if (appUser?.role !== 'admin') {
    return (
      <div style={{ padding: '40px 32px', color: 'var(--text-muted)', fontSize: 14 }}>
        Admin access is required to manage users and access templates.
      </div>
    )
  }

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1100 }}>
      <h1 style={{ fontFamily: SERIF, fontSize: 26, color: WILKOW, marginBottom: 2 }}>Administration</h1>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 20 }}>
        Create logins, assign roles, and build reusable access templates that control which pages and properties each person sees.
      </p>

      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '1px solid var(--border)' }}>
        {(['users', 'templates'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: '9px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            background: 'none', border: 'none', textTransform: 'capitalize',
            color: tab === t ? WILKOW : 'var(--text-muted)',
            borderBottom: tab === t ? `2px solid ${WILKOW}` : '2px solid transparent',
          }}>{t === 'templates' ? 'Access templates' : 'Users'}</button>
        ))}
      </div>

      {tab === 'users' ? <UsersTab /> : <TemplatesTab />}
    </div>
  )
}

// ═══════════════════════════════════════════════ USERS ══════════════════════
function UsersTab() {
  const { appUser } = useAuth()
  const { data: users, loading, refetch } = useUsers()
  const { data: templates } = useAccessTemplates()
  const { data: properties } = useProperties()
  const { data: portfolios } = usePortfolios()
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  const tps = templates ?? []
  const props = useMemo(() => (properties ?? []).map(p => ({ id: p.id, name: p.name })), [properties])
  const ports = useMemo(() => (portfolios ?? []).map(p => ({ id: p.id, name: p.name })), [portfolios])

  if (loading) return <WidgetSkeleton />

  return (
    <div>
      <Toast msg={msg} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <button style={btn('primary')} onClick={() => { setAdding(a => !a); setEditing(null) }}>
          {adding ? 'Cancel' : '+ Add user'}
        </button>
      </div>

      {adding && (
        <div style={{ ...card, marginBottom: 18 }}>
          <AddUserForm templates={tps} onDone={(m) => { setMsg(m); if (m.type === 'success') { setAdding(false); refetch() } }} />
        </div>
      )}

      <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'var(--surface-2)', textAlign: 'left', color: 'var(--text-muted)' }}>
              <th style={th}>User</th><th style={th}>Role</th><th style={th}>Status</th><th style={th}>Pages</th><th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map(u => (
              <UserRow
                key={u.id} user={u} templates={tps} properties={props} portfolios={ports}
                isSelf={u.id === appUser?.id}
                expanded={editing === u.id}
                onToggle={() => setEditing(e => e === u.id ? null : u.id)}
                onChanged={(m) => { setMsg(m); refetch() }}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const th: CSSProperties = { padding: '10px 14px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }
const td: CSSProperties = { padding: '11px 14px', borderTop: '1px solid var(--border)', verticalAlign: 'middle' }

function pagesSummary(u: AdminUser): string {
  if (u.role === 'admin') return 'All'
  if (!u.allowed_pages) return u.role === 'asset_manager' ? 'All' : 'All (role default)'
  return `${u.allowed_pages.length} page${u.allowed_pages.length === 1 ? '' : 's'}`
}

interface NamedRef { id: string; name: string }

function UserRow({ user, templates, properties, portfolios, isSelf, expanded, onToggle, onChanged }: {
  user: AdminUser
  templates: AccessTemplate[]
  properties: NamedRef[]
  portfolios: NamedRef[]
  isSelf: boolean
  expanded: boolean
  onToggle: () => void
  onChanged: (m: { type: 'success' | 'error'; text: string }) => void
}) {
  const [busy, setBusy] = useState(false)
  const [role, setRole] = useState<UserRole>(user.role)
  const [active, setActive] = useState(user.is_active)
  const [pages, setPages] = useState<string[] | null>(user.allowed_pages)
  const [applyId, setApplyId] = useState('')

  async function guard(fn: () => Promise<void>, ok: string) {
    setBusy(true)
    try { await fn(); onChanged({ type: 'success', text: ok }) }
    catch (e) { onChanged({ type: 'error', text: e instanceof Error ? e.message : String(e) }) }
    finally { setBusy(false) }
  }

  return (
    <>
      <tr>
        <td style={td}>
          <div style={{ fontWeight: 600, color: 'var(--text)' }}>{user.full_name || '—'}</div>
          <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>{user.email}</div>
        </td>
        <td style={td}>{ROLE_LABEL[user.role]}</td>
        <td style={td}>
          <span style={{
            fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 20,
            background: user.is_active ? 'var(--green-bg)' : 'var(--surface-2)',
            color: user.is_active ? 'var(--green)' : 'var(--text-faint)',
          }}>{user.is_active ? 'Active' : 'Disabled'}</span>
        </td>
        <td style={{ ...td, color: 'var(--text-muted)' }}>{pagesSummary(user)}</td>
        <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
          <button style={btn()} onClick={onToggle}>{expanded ? 'Close' : 'Edit'}</button>
        </td>
      </tr>

      {expanded && (
        <tr>
          <td style={{ ...td, background: 'var(--surface-2)' }} colSpan={5}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
              {/* left: role / status / template */}
              <div>
                <label style={label}>Role</label>
                <select style={input} value={role} onChange={e => setRole(e.target.value as UserRole)}>
                  {ROLES.map(r => <option key={r.value} value={r.value}>{r.label} — {r.hint}</option>)}
                </select>

                <label style={{ ...label, marginTop: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} disabled={isSelf} />
                  Account active {isSelf && <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>(can't disable yourself)</span>}
                </label>

                <div style={{ marginTop: 16 }}>
                  <label style={label}>Apply a template</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <select style={input} value={applyId} onChange={e => setApplyId(e.target.value)}>
                      <option value="">Choose template…</option>
                      {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    <button style={btn()} disabled={!applyId || busy} onClick={() => {
                      const t = templates.find(x => x.id === applyId)
                      if (!t) return
                      guard(async () => {
                        await applyTemplate(user.id, t)
                        setRole(t.role); setPages(t.pages)
                        onToggle() // collapse so the row re-opens with fresh state
                      }, `Applied "${t.name}" to ${user.email}`)
                    }}>Apply</button>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6 }}>
                    Overwrites this user's role, page access and property entitlements.
                  </div>
                </div>
              </div>

              {/* right: page access + entitlement summary */}
              <div>
                <label style={label}>Page access {role === 'admin' && <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}>(admins see everything)</span>}</label>
                <div style={{ opacity: role === 'admin' ? 0.5 : 1, pointerEvents: role === 'admin' ? 'none' : 'auto' }}>
                  <PagePicker role={role} value={pages} onChange={setPages} />
                </div>
                {role !== 'admin' && (
                  <div style={{ marginTop: 16 }}>
                    <PropertyAccessEditor
                      role={role}
                      properties={properties}
                      portfolios={portfolios}
                      entitlements={user.entitlements ?? []}
                      busy={busy}
                      onSave={(ents) => guard(async () => {
                        await setUserEntitlements(user.id, ents)
                        onToggle()
                      }, `Saved property access for ${user.email}`)}
                    />
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 18, alignItems: 'center' }}>
              <button style={btn('primary')} disabled={busy} onClick={() => guard(
                () => updateUser(user.id, { role, is_active: active, allowed_pages: role === 'admin' ? null : pages }),
                `Saved ${user.email}`,
              )}>Save changes</button>

              <button style={btn()} disabled={busy} onClick={() => {
                const pw = genPassword()
                guard(async () => {
                  await setPassword(user.id, pw)
                  await navigator.clipboard?.writeText(pw).catch(() => {})
                }, `New password for ${user.email} (copied to clipboard): ${pw}`)
              }}>Reset password</button>

              <div style={{ flex: 1 }} />
              {!isSelf && (
                <button style={btn('danger')} disabled={busy} onClick={() => {
                  if (!confirm(`Delete ${user.email}? Their login and access are removed permanently.`)) return
                  guard(() => deleteUser(user.id).then(() => {}), `Deleted ${user.email}`)
                }}>Delete user</button>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function PagePicker({ role, value, onChange }: {
  role: UserRole
  value: string[] | null
  onChange: (v: string[] | null) => void
}) {
  // Property managers can't be granted restricted (financial/capital) pages.
  const options = ASSIGNABLE_PAGES.filter(p => !(p.restricted && role === 'property_manager'))
  const all = value === null
  return (
    <div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 8 }}>
        <input type="checkbox" checked={all} onChange={e => onChange(e.target.checked ? null : options.map(o => o.key))} />
        All pages allowed for this role
      </label>
      {!all && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' }}>
          {options.map(p => (
            <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={value?.includes(p.key) ?? false}
                onChange={e => {
                  const set = new Set(value ?? [])
                  e.target.checked ? set.add(p.key) : set.delete(p.key)
                  onChange([...set])
                }}
              />
              <span>{p.icon} {p.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

// Direct per-user asset assignment — an alternative to applying a template.
// Writes the user's entitlement rows on save (global grant, or specific
// portfolios/properties). For asset managers, "specific" scopes their data to
// those assets (see migration 20240040); "all" keeps full-portfolio access.
function PropertyAccessEditor({ role, properties, portfolios, entitlements, busy, onSave }: {
  role: UserRole
  properties: NamedRef[]
  portfolios: NamedRef[]
  entitlements: { scope: string; property_id: string | null; portfolio_id: string | null; can_write: boolean; can_upload: boolean }[]
  busy: boolean
  onSave: (ents: NewEntitlement[]) => void
}) {
  const hasGlobal = entitlements.some(e => e.scope === 'global')
  const initialMode: 'global' | 'custom' =
    hasGlobal || (entitlements.length === 0 && role === 'asset_manager') ? 'global' : 'custom'
  const [mode, setMode] = useState<'global' | 'custom'>(initialMode)
  const [propIds, setPropIds] = useState<Set<string>>(new Set(entitlements.filter(e => e.scope === 'property' && e.property_id).map(e => e.property_id as string)))
  const [portIds, setPortIds] = useState<Set<string>>(new Set(entitlements.filter(e => e.scope === 'portfolio' && e.portfolio_id).map(e => e.portfolio_id as string)))
  const [canWrite, setCanWrite] = useState(entitlements[0]?.can_write ?? false)
  const [canUpload, setCanUpload] = useState(entitlements[0]?.can_upload ?? (role === 'property_manager'))
  const [err, setErr] = useState<string | null>(null)

  function toggle(set: Set<string>, setFn: (s: Set<string>) => void, id: string, on: boolean) {
    const next = new Set(set)
    on ? next.add(id) : next.delete(id)
    setFn(next)
  }

  function save() {
    setErr(null)
    if (mode === 'global') {
      onSave([{ scope: 'global', can_read: true, can_write: canWrite, can_upload: canUpload }])
      return
    }
    if (!propIds.size && !portIds.size) {
      setErr(role === 'asset_manager'
        ? 'Select at least one asset — an asset manager with none assigned would fall back to full access.'
        : 'Select at least one asset (or choose "All properties").')
      return
    }
    const ents: NewEntitlement[] = [
      ...[...portIds].map(id => ({ scope: 'portfolio' as const, portfolio_id: id, can_read: true, can_write: canWrite, can_upload: canUpload })),
      ...[...propIds].map(id => ({ scope: 'property'  as const, property_id:  id, can_read: true, can_write: canWrite, can_upload: canUpload })),
    ]
    onSave(ents)
  }

  return (
    <div>
      <label style={label}>Property access</label>
      <select style={{ ...input, maxWidth: 260 }} value={mode} onChange={e => setMode(e.target.value as 'global' | 'custom')}>
        <option value="global">All properties</option>
        <option value="custom">Specific assets</option>
      </select>

      {mode === 'custom' && (
        <div style={{ marginTop: 10 }}>
          {!!portfolios.length && (
            <>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', margin: '4px 0' }}>Portfolios</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px', marginBottom: 8 }}>
                {portfolios.map(p => (
                  <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <input type="checkbox" checked={portIds.has(p.id)} onChange={e => toggle(portIds, setPortIds, p.id, e.target.checked)} />
                    <span>{p.name}</span>
                  </label>
                ))}
              </div>
            </>
          )}
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', margin: '4px 0' }}>Properties</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px', maxHeight: 160, overflowY: 'auto' }}>
            {properties.map(p => (
              <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input type="checkbox" checked={propIds.has(p.id)} onChange={e => toggle(propIds, setPropIds, p.id, e.target.checked)} />
                <span>{p.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={canUpload} onChange={e => setCanUpload(e.target.checked)} /> Can upload documents
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <input type="checkbox" checked={canWrite} onChange={e => setCanWrite(e.target.checked)} /> Can edit data
        </label>
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 8 }}>{err}</div>}
      <button style={{ ...btn(), marginTop: 10 }} disabled={busy} onClick={save}>Save property access</button>
    </div>
  )
}

function AddUserForm({ templates, onDone }: {
  templates: AccessTemplate[]
  onDone: (m: { type: 'success' | 'error'; text: string }) => void
}) {
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [password, setPassword] = useState(genPassword())
  const [templateId, setTemplateId] = useState('')
  const [role, setRole] = useState<UserRole>('property_manager')
  const [busy, setBusy] = useState(false)

  const tmpl = templates.find(t => t.id === templateId) ?? null

  async function submit() {
    setBusy(true)
    try {
      const base = { email, full_name: fullName, password }
      let out
      if (tmpl) {
        out = await createUser({
          ...base, role: tmpl.role, allowed_pages: tmpl.pages,
          template_id: tmpl.id, entitlements: entitlementsFromTemplate(tmpl),
        })
        // The edge fn owns login creation; the template's dashboard preset is
        // materialized here through admin RLS (same path applyTemplate uses).
        if (tmpl.dashboard_widgets?.length && out.user_id) {
          await updateUser(String(out.user_id), { dashboard_widgets: tmpl.dashboard_widgets })
        }
      } else {
        out = await createUser({ ...base, role })
      }
      await navigator.clipboard?.writeText(password).catch(() => {})
      onDone({ type: 'success', text: `Created ${out.email} — temp password copied to clipboard: ${password}` })
    } catch (e) {
      onDone({ type: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally { setBusy(false) }
  }

  return (
    <div>
      <div style={{ fontWeight: 700, marginBottom: 14, color: 'var(--text)' }}>New user</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div>
          <label style={label}>Email</label>
          <input style={input} type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@wilkow.com" />
        </div>
        <div>
          <label style={label}>Full name</label>
          <input style={input} value={fullName} onChange={e => setFullName(e.target.value)} placeholder="Jane Manager" />
        </div>
        <div>
          <label style={label}>Temporary password</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={input} value={password} onChange={e => setPassword(e.target.value)} />
            <button style={btn()} type="button" onClick={() => setPassword(genPassword())}>Generate</button>
          </div>
        </div>
        <div>
          <label style={label}>Access template</label>
          <select style={input} value={templateId} onChange={e => setTemplateId(e.target.value)}>
            <option value="">— set role manually —</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        {!tmpl && (
          <div>
            <label style={label}>Role</label>
            <select style={input} value={role} onChange={e => setRole(e.target.value as UserRole)}>
              {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
        )}
      </div>
      {tmpl && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
          Applies <b>{ROLE_LABEL[tmpl.role]}</b> · {tmpl.pages ? `${tmpl.pages.length} pages` : 'all pages'} · {tmpl.grant_scope === 'global' ? 'all properties' : `${tmpl.resource_ids.length} ${tmpl.grant_scope}(s)`}.
        </div>
      )}
      <div style={{ marginTop: 16 }}>
        <button style={btn('primary')} disabled={busy || !email || password.length < 8} onClick={submit}>
          {busy ? 'Creating…' : 'Create user'}
        </button>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════ TEMPLATES ══════════════════════
const EMPTY_TEMPLATE: Partial<AccessTemplate> = {
  name: '', description: '', role: 'property_manager', pages: null,
  grant_scope: 'global', resource_ids: [], can_write: false, can_upload: false,
  dashboard_widgets: null,
}

function TemplatesTab() {
  const { data: templates, loading, refetch } = useAccessTemplates()
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [draft, setDraft] = useState<Partial<AccessTemplate> | null>(null)

  if (loading) return <WidgetSkeleton />

  return (
    <div>
      <Toast msg={msg} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <button style={btn('primary')} onClick={() => setDraft(draft ? null : { ...EMPTY_TEMPLATE })}>
          {draft ? 'Cancel' : '+ New template'}
        </button>
      </div>

      {draft && (
        <div style={{ ...card, marginBottom: 18 }}>
          <TemplateForm
            draft={draft}
            onCancel={() => setDraft(null)}
            onSaved={(m) => { setMsg(m); if (m.type === 'success') { setDraft(null); refetch() } }}
          />
        </div>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        {(templates ?? []).map(t => (
          <div key={t.id} style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: 15 }}>{t.name}</div>
              {t.description && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{t.description}</div>}
              <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Chip>{ROLE_LABEL[t.role]}</Chip>
                <Chip>{t.pages ? `${t.pages.length} pages` : 'all pages'}</Chip>
                <Chip>{t.grant_scope === 'global' ? 'all properties' : `${t.resource_ids.length} ${t.grant_scope}(s)`}</Chip>
                <Chip>{t.dashboard_widgets ? `${t.dashboard_widgets.length}-widget dashboard` : 'default dashboard'}</Chip>
                {t.can_write && <Chip>can edit</Chip>}
                {t.can_upload && <Chip>can upload</Chip>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button style={btn()} onClick={() => setDraft(t)}>Edit</button>
              <button style={btn('danger')} onClick={() => {
                if (!confirm(`Delete template "${t.name}"? Users it was applied to keep their current access.`)) return
                deleteTemplate(t.id).then(() => { setMsg({ type: 'success', text: `Deleted "${t.name}"` }); refetch() })
                  .catch(e => setMsg({ type: 'error', text: String(e) }))
              }}>Delete</button>
            </div>
          </div>
        ))}
        {!templates?.length && <div style={{ color: 'var(--text-faint)', fontSize: 13, padding: 20 }}>No templates yet.</div>}
      </div>
    </div>
  )
}

function Chip({ children }: { children: ReactNode }) {
  return <span style={{ background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 20, padding: '2px 10px', fontSize: 11, fontWeight: 600 }}>{children}</span>
}

function TemplateForm({ draft, onCancel, onSaved }: {
  draft: Partial<AccessTemplate>
  onCancel: () => void
  onSaved: (m: { type: 'success' | 'error'; text: string }) => void
}) {
  const { data: properties } = useProperties()
  const { data: portfolios } = usePortfolios()
  const [t, setT] = useState<Partial<AccessTemplate>>(draft)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<AccessTemplate>) => setT(prev => ({ ...prev, ...patch }))

  const role = (t.role ?? 'property_manager') as UserRole
  const scope = (t.grant_scope ?? 'global') as EntitlementScope
  const resources = useMemo(() => {
    if (scope === 'portfolio') return (portfolios ?? []).map(p => ({ id: p.id, name: p.name }))
    if (scope === 'property')  return (properties ?? []).map(p => ({ id: p.id, name: p.name }))
    return []
  }, [scope, portfolios, properties])

  const ids = new Set(t.resource_ids ?? [])
  const pageOptions = ASSIGNABLE_PAGES.filter(p => !(p.restricted && role === 'property_manager'))

  async function save() {
    if (!t.name?.trim()) { onSaved({ type: 'error', text: 'Template name is required' }); return }
    setBusy(true)
    try {
      await saveTemplate({
        id: t.id, name: t.name.trim(), description: t.description ?? null, role,
        pages: t.pages ?? null, grant_scope: scope,
        resource_ids: scope === 'global' ? [] : [...ids],
        can_write: t.can_write ?? false, can_upload: t.can_upload ?? false,
        dashboard_widgets: t.dashboard_widgets ?? null,
      })
      onSaved({ type: 'success', text: `Saved "${t.name}"` })
    } catch (e) {
      onSaved({ type: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally { setBusy(false) }
  }

  return (
    <div>
      <div style={{ fontWeight: 700, marginBottom: 14, color: 'var(--text)' }}>{t.id ? 'Edit template' : 'New template'}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div>
          <label style={label}>Name</label>
          <input style={input} value={t.name ?? ''} onChange={e => set({ name: e.target.value })} placeholder="e.g. Gateway PM" />
        </div>
        <div>
          <label style={label}>Role</label>
          <select style={input} value={role} onChange={e => set({ role: e.target.value as UserRole })}>
            {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={label}>Description</label>
          <input style={input} value={t.description ?? ''} onChange={e => set({ description: e.target.value })} placeholder="What this profile is for" />
        </div>
      </div>

      <div style={{ marginTop: 18 }}>
        <label style={label}>Pages this profile sees</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 8 }}>
          <input type="checkbox" checked={t.pages == null} onChange={e => set({ pages: e.target.checked ? null : pageOptions.map(p => p.key) })} />
          All pages allowed for this role
        </label>
        {t.pages != null && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px 12px' }}>
            {pageOptions.map(p => (
              <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input type="checkbox" checked={t.pages?.includes(p.key) ?? false} onChange={e => {
                  const s = new Set(t.pages ?? [])
                  e.target.checked ? s.add(p.key) : s.delete(p.key)
                  set({ pages: [...s] })
                }} />
                <span>{p.icon} {p.label}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 18 }}>
        <label style={label}>Dashboard this profile opens with</label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 8 }}>
          <input type="checkbox" checked={t.dashboard_widgets == null}
            onChange={e => set({ dashboard_widgets: e.target.checked ? null : [...ROLE_PRESETS[role]] })} />
          Default dashboard for this role
        </label>
        {t.dashboard_widgets != null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {DASHBOARD_SECTIONS.map(sec => {
              const defs = WIDGET_DEFS.filter(w => w.section === sec.id)
              if (!defs.length) return null
              return (
                <div key={sec.id}>
                  <div style={{ fontSize: 10, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-faint)', margin: '2px 0 4px' }}>
                    {sec.label}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px 12px' }}>
                    {defs.map(w => (
                      <label key={w.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                        <input type="checkbox" checked={t.dashboard_widgets?.includes(w.key) ?? false} onChange={e => {
                          const s = new Set(t.dashboard_widgets ?? [])
                          e.target.checked ? s.add(w.key) : s.delete(w.key)
                          // Persist in registry order so the dashboard renders predictably.
                          set({ dashboard_widgets: WIDGET_DEFS.map(d => d.key).filter(k => s.has(k)) })
                        }} />
                        <span>{w.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            })}
            <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
              Users can still add, hide, and reorder widgets themselves; this sets what they open with and what Reset restores.
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: 18 }}>
        <label style={label}>Property access</label>
        <select style={{ ...input, maxWidth: 260 }} value={scope} onChange={e => set({ grant_scope: e.target.value as EntitlementScope, resource_ids: [] })}>
          <option value="global">All properties (global)</option>
          <option value="portfolio">Specific portfolios</option>
          <option value="property">Specific properties</option>
        </select>
        {scope !== 'global' && (
          <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', maxHeight: 180, overflowY: 'auto' }}>
            {resources.map(r => (
              <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <input type="checkbox" checked={ids.has(r.id)} onChange={e => {
                  const s = new Set(ids)
                  e.target.checked ? s.add(r.id) : s.delete(r.id)
                  set({ resource_ids: [...s] })
                }} />
                <span>{r.name}</span>
              </label>
            ))}
            {!resources.length && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>None available.</span>}
          </div>
        )}
      </div>

      <div style={{ marginTop: 18, display: 'flex', gap: 20 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <input type="checkbox" checked={t.can_write ?? false} onChange={e => set({ can_write: e.target.checked })} /> Can edit data
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <input type="checkbox" checked={t.can_upload ?? false} onChange={e => set({ can_upload: e.target.checked })} /> Can upload documents
        </label>
      </div>

      <div style={{ marginTop: 20, display: 'flex', gap: 8 }}>
        <button style={btn('primary')} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save template'}</button>
        <button style={btn()} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
