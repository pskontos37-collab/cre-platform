import { useState, useEffect, useMemo, type CSSProperties, type ReactNode } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { useProperties } from '../hooks/useProperties'
import { useManagementAgreements, type MgmtAgreement, type MgmtDeadline } from '../hooks/useManagementAgreements'
import { supabase } from '../lib/supabase'
import { Widget, WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'
import { DocAbstractsButton, type AbstractDocRef } from '../components/DocAbstractsButton'
import { AgreementQaBadge, AgreementQaPanel } from '../components/AgreementQaPanel'
import { AgreementAbstractPanel } from '../components/AgreementAbstractPanel'
import { AgreementAbstractPdfButton } from '../reports/AgreementAbstractPdfButton'

// Discrete, queryable columns (each is a prompt).
const NUM_FIELDS: { key: keyof MgmtAgreement; label: string; suffix?: string; pct?: boolean }[] = [
  { key: 'mgmt_fee_pct', label: 'Management fee', suffix: '%', pct: true },
  { key: 'construction_fee_pct', label: 'Construction fee', suffix: '%', pct: true },
  { key: 'leasing_fee_pct', label: 'Leasing fee', suffix: '%', pct: true },
  { key: 'budget_variance_pct', label: 'Budget variance needing approval', suffix: '%', pct: true },
  { key: 'termination_notice_days', label: 'Termination notice', suffix: 'days' },
  { key: 'monthly_report_due_day', label: 'Monthly report due (day of month)' },
]
const TEXT_FIELDS: { key: keyof MgmtAgreement; label: string }[] = [
  { key: 'manager_name', label: 'Manager' },
  { key: 'sub_manager_name', label: 'Sub-manager' },
  { key: 'owner_name', label: 'Owner' },
  { key: 'effective_date', label: 'Effective date (YYYY-MM-DD)' },
  { key: 'term_start', label: 'Term start' },
  { key: 'term_end', label: 'Term end' },
]
// Narrative term sections stored in the `terms` jsonb — the comprehensive capture.
const TERM_SECTIONS: { key: string; label: string }[] = [
  { key: 'fees', label: 'Fees — full schedule (mgmt, construction tiers, leasing new/renewal, other)' },
  { key: 'construction_fee', label: 'Construction management fee — verified (rate, basis, billing trigger, exclusions)' },
  { key: 'authority', label: 'Manager spending / decision authority (thresholds, emergency, contract limits)' },
  { key: 'owner_approval', label: 'Owner / JV approval items (what needs sign-off + thresholds)' },
  { key: 'submittals', label: 'Submittals & reporting (what + frequency + due dates)' },
  { key: 'budget', label: 'Budget process (submission deadline, approval, permitted variance)' },
  { key: 'leasing', label: 'Leasing authority (SF/term caps, standard form)' },
  { key: 'funds', label: 'Funds handling (accounts, sweeps, reserves, deposits)' },
  { key: 'insurance', label: 'Insurance (required coverages + limits)' },
  { key: 'standard_of_care', label: 'Standard of care / indemnity / liability' },
  { key: 'termination', label: 'Termination & renewal detail' },
]

export function ManagementPage() {
  const { appUser } = useAuth()
  const { data: properties } = useProperties()
  const [propertyId, setPropertyId] = useState<string | null>(null)
  useEffect(() => { if (!propertyId && properties?.length) setPropertyId(properties[0].id) }, [properties, propertyId])

  const { data: agreements, loading, error, refetch } = useManagementAgreements(propertyId)
  const [agreementId, setAgreementId] = useState<string | null>(null)
  useEffect(() => { setAgreementId(agreements?.[0]?.id ?? null) }, [agreements])
  const agreement = useMemo(() => agreements?.find(a => a.id === agreementId) ?? null, [agreements, agreementId])

  // Effective terms across the stack: amendments only capture what they CHANGED,
  // so merge base + amendments (ascending effective_date; later wins, nulls
  // never overwrite). "Needs review" is judged against this merge — a sparse
  // amendment is not an extraction gap.
  const effective = useMemo(() => {
    const fields: Record<string, unknown> = {}
    const terms: Record<string, unknown> = {}
    for (const a of agreements ?? []) {
      for (const k of [...NUM_FIELDS, ...TEXT_FIELDS]) {
        const v = (a as Record<string, unknown>)[k.key as string]
        if (v !== null && v !== undefined && v !== '') fields[k.key as string] = v
      }
      for (const [k, v] of Object.entries(a.terms ?? {})) if (v) terms[k] = v
    }
    return { fields, terms }
  }, [agreements])

  // Active PMA documents (the current governing stack) for the on-demand
  // narrative-abstract pack — falls back to all linked docs if none flagged current.
  const propName = (properties ?? []).find(p => p.id === propertyId)?.name ?? ''
  const abstractDocs = useMemo<AbstractDocRef[]>(() => {
    const linked = (agreements ?? []).filter(a => a.document_id)
    const current = linked.filter(a => a.is_current)
    const use = current.length ? current : linked
    return use.map(a => ({
      documentId: a.document_id as string,
      propertyId: a.property_id,
      title: `${a.role === 'amendment' ? 'Amendment' : 'Management agreement'} — ${a.manager_name ?? 'Manager'}${a.effective_date ? ` (${a.effective_date})` : ''}`,
      docType: 'management_agreement',
      roleLabel: a.role,
      context: { role: a.role, manager: a.manager_name, owner: a.owner_name, effective_date: a.effective_date, term_start: a.term_start, term_end: a.term_end },
    }))
  }, [agreements])

  if (appUser?.role !== 'admin' && appUser?.role !== 'asset_manager') {
    return <div style={{ padding: '40px 32px', color: 'var(--text-muted)', fontSize: 14 }}>You need admin or asset manager access to view management agreements.</div>
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1000 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Management Agreements</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18 }}>
        Captured operational terms from each property's PMA — fees, spending &amp; approval authority, submittals, budget process, and termination.
        Empty fields are flagged for review; submittal deadlines can be pushed to the dashboard calendar.
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 18 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 260 }}>
          <span style={lbl}>Property</span>
          <select value={propertyId ?? ''} onChange={e => setPropertyId(e.target.value)} style={ctl}>
            {(properties ?? []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {agreements && agreements.length > 0 && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 300 }}>
            <span style={lbl}>Agreement</span>
            <select value={agreementId ?? ''} onChange={e => setAgreementId(e.target.value)} style={ctl}>
              {agreements.map(a => <option key={a.id} value={a.id}>{a.role} · {a.manager_name ?? 'Manager'} · {a.effective_date ?? '—'}</option>)}
            </select>
          </label>
        )}
        <span style={{ marginLeft: 'auto' }}>
          <DocAbstractsButton
            kind="management"
            docs={abstractDocs}
            reportTitle={propName || 'Management Agreement'}
            reportSubtitle="Narrative abstract of the active management agreement(s)"
            scopeLabel={propName ? `${propName} · ${abstractDocs.length} document${abstractDocs.length === 1 ? '' : 's'}` : ''}
            fileName={`Wilkow-Management-Abstract-${(propName || 'property').replace(/[^\w.-]+/g, '-')}.pdf`}
            disabled={abstractDocs.length === 0}
            disabledReason="No management-agreement document is linked for this property yet"
          />
        </span>
      </div>

      {loading && <WidgetSkeleton rows={8} />}
      {error && <EmptyState title="Couldn't load agreements" subtitle={error.includes('does not exist') || error.includes('management_agreements') ? 'The management_agreements schema is not applied yet — run migration 20240022.' : error} />}
      {agreements && agreements.length === 0 && !loading && (
        <EmptyState title="No management agreement captured for this property" subtitle="Once migration 20240022 is applied and rows are seeded, PMAs appear here for review." />
      )}

      {agreement && <AgreementEditor key={agreement.id} agreement={agreement} effective={effective} onSaved={refetch} />}
    </div>
  )
}

interface EffectiveTerms { fields: Record<string, unknown>; terms: Record<string, unknown> }

function AgreementEditor({ agreement, effective, onSaved }: {
  agreement: MgmtAgreement
  effective: EffectiveTerms
  onSaved: () => void
}) {
  const [form, setForm] = useState<Record<string, unknown>>({})
  const [terms, setTerms] = useState<Record<string, unknown>>({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    const f: Record<string, unknown> = {}
    for (const k of [...NUM_FIELDS, ...TEXT_FIELDS]) f[k.key as string] = (agreement as Record<string, unknown>)[k.key as string] ?? ''
    f.notes = agreement.notes ?? ''
    setForm(f)
    setTerms({ ...(agreement.terms ?? {}) })
  }, [agreement])

  // Judge "needs review" against the EFFECTIVE stack, not this document alone.
  const missing = useMemo(() => {
    let n = 0
    for (const k of [...NUM_FIELDS, ...TEXT_FIELDS]) {
      const own = form[k.key as string]
      const eff = effective.fields[k.key as string]
      if ((own === '' || own == null) && (eff === '' || eff == null)) n++
    }
    for (const s of TERM_SECTIONS) if (!terms[s.key] && !effective.terms[s.key]) n++
    return n
  }, [form, terms, effective])

  async function save() {
    setSaving(true); setMsg(null)
    const patch: Record<string, unknown> = { terms, notes: form.notes || null, updated_at: new Date().toISOString() }
    for (const k of NUM_FIELDS) { const v = form[k.key as string]; patch[k.key as string] = v === '' || v == null ? null : Number(v) }
    for (const k of TEXT_FIELDS) { const v = form[k.key as string]; patch[k.key as string] = v === '' ? null : v }
    const { error } = await supabase.from('management_agreements').update(patch).eq('id', agreement.id)
    setSaving(false)
    setMsg(error ? `Save failed: ${error.message}` : 'Saved.')
    if (!error) onSaved()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: missing > 0 ? 'var(--warn, #b45309)' : 'var(--text-faint)' }}>
          {missing > 0
            ? `${missing} term${missing === 1 ? '' : 's'} unknown across the agreement stack`
            : agreement.role === 'amendment'
              ? 'All tracked terms captured (amendments show only what they changed — grayed values are inherited)'
              : 'All tracked terms captured'}
        </span>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {msg && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{msg}</span>}
          <AgreementQaBadge status={agreement.qa_status} />
          {agreement.document_id && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>source doc linked</span>}
          {agreement.abstract && (
            <AgreementAbstractPdfButton
              kind="pma"
              name={`${agreement.manager_name ?? 'Management Agreement'}${agreement.effective_date ? ` (${agreement.effective_date})` : ''}`}
              abstract={agreement.abstract} qa={agreement.qa} qaStatus={agreement.qa_status} qaAt={agreement.qa_at}
            />
          )}
          <button onClick={save} disabled={saving} style={btn}>{saving ? 'Saving…' : 'Save terms'}</button>
        </div>
      </div>

      {/* Verified abstract (agreement-abstract kind=pma): the brief-synthesis
          of the executed PMA + amendment chain — fees, termination, and the
          approvals/spending-authority block (what the manager may commit vs.
          what needs owner sign-off, with scope + expense thresholds). */}
      {agreement.abstract && <AgreementAbstractPanel kind="pma" abstract={agreement.abstract} />}

      {/* Document-verification verdict (agreement-verify kind=pma): the
          abstracted PMA terms audited against the executed agreement, with
          tracker reconciliation where this page's values disagree. */}
      {agreement.qa && <AgreementQaPanel qa={agreement.qa} qaStatus={agreement.qa_status} qaAt={agreement.qa_at} />}

      <Widget title="Key terms" chip="prompted fields · gray = inherited from earlier document">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
          {TEXT_FIELDS.map(f => (
            <Field key={f.key as string} label={f.label} filled={!!form[f.key as string]}
              inherited={!form[f.key as string] && effective.fields[f.key as string] != null}>
              <input value={String(form[f.key as string] ?? '')}
                placeholder={!form[f.key as string] && effective.fields[f.key as string] != null ? `inherited: ${effective.fields[f.key as string]}` : undefined}
                onChange={e => setForm({ ...form, [f.key as string]: e.target.value })} style={ctl} />
            </Field>
          ))}
          {NUM_FIELDS.map(f => (
            <Field key={f.key as string} label={f.label + (f.suffix ? ` (${f.suffix})` : '')}
              filled={form[f.key as string] !== '' && form[f.key as string] != null}
              inherited={(form[f.key as string] === '' || form[f.key as string] == null) && effective.fields[f.key as string] != null}>
              <input type="number" step="any" value={String(form[f.key as string] ?? '')}
                placeholder={(form[f.key as string] === '' || form[f.key as string] == null) && effective.fields[f.key as string] != null ? `inherited: ${effective.fields[f.key as string]}` : undefined}
                onChange={e => setForm({ ...form, [f.key as string]: e.target.value })} style={ctl} />
            </Field>
          ))}
        </div>
      </Widget>

      <Widget title="Detailed terms" chip="comprehensive capture">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {TERM_SECTIONS.map(s => {
            const own = terms[s.key]
            const eff = effective.terms[s.key]
            const ownIsObj = own != null && typeof own === 'object'
            const effIsObj = !own && eff != null && typeof eff === 'object'
            const displayObj = ownIsObj ? own : effIsObj ? eff : null
            return (
              <Field key={s.key} label={s.label} filled={!!own} inherited={!own && !!eff}>
                {displayObj != null ? (
                  <div style={structBox}>
                    {effIsObj && <div style={{ fontSize: 10, color: 'var(--text-faint)', marginBottom: 6 }}>inherited from earlier document</div>}
                    <TermValue value={displayObj} />
                  </div>
                ) : (
                  <textarea rows={String(own ?? '').length > 160 ? 4 : 2} value={String(own ?? '')}
                    placeholder={!own && eff ? `inherited: ${String(eff).slice(0, 160)}…` : undefined}
                    onChange={e => setTerms({ ...terms, [s.key]: e.target.value })} style={{ ...ctl, resize: 'vertical', fontFamily: 'inherit' }} />
                )}
              </Field>
            )
          })}
          <Field label="Notes" filled={!!form.notes}>
            <textarea rows={2} value={String(form.notes ?? '')} onChange={e => setForm({ ...form, notes: e.target.value })} style={{ ...ctl, resize: 'vertical', fontFamily: 'inherit' }} />
          </Field>
        </div>
      </Widget>

      <DeadlinesEditor agreement={agreement} onChanged={onSaved} />
    </div>
  )
}

function DeadlinesEditor({ agreement, onChanged }: { agreement: MgmtAgreement; onChanged: () => void }) {
  const rows = agreement.management_agreement_deadlines ?? []
  const [busy, setBusy] = useState<string | null>(null)

  async function pushToCalendar(d: MgmtDeadline) {
    if (!d.next_due) { alert('Set a "next due" date on this deadline first.'); return }
    setBusy(d.id)
    const { error } = await supabase.from('critical_dates').insert({
      property_id: agreement.property_id, management_agreement_id: agreement.id,
      date_type: 'other', due_date: d.next_due, description: `PMA: ${d.label}`, alert_days_before: [30, 14, 7],
    })
    setBusy(null)
    if (error) alert('Failed: ' + error.message); else { alert('Added to calendar.'); onChanged() }
  }

  return (
    <Widget title="Submittals & deadlines" chip={`${rows.length} tracked`} fullWidth>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>No submittal deadlines captured yet. Seed them from the abstraction, or add rows once the schema is live.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead><tr style={{ textAlign: 'left', color: 'var(--text-faint)', fontSize: 11 }}>
            <th style={th}>Deadline</th><th style={th}>Kind</th><th style={th}>Frequency</th><th style={th}>Rule</th><th style={th}>Next due</th><th style={th}></th>
          </tr></thead>
          <tbody>
            {rows.map(d => (
              <tr key={d.id} style={{ borderTop: '1px solid var(--border)' }}>
                <td style={td}>{d.label}</td>
                <td style={td}>{d.kind}</td>
                <td style={td}>{d.frequency ?? '—'}</td>
                <td style={{ ...td, color: 'var(--text-muted)' }}>{d.due_rule ?? '—'}</td>
                <td style={td}>{d.next_due ?? '—'}</td>
                <td style={{ ...td, textAlign: 'right' }}>
                  <button onClick={() => pushToCalendar(d)} disabled={busy === d.id} style={{ ...btn, fontSize: 11, padding: '3px 8px' }}>Add to calendar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Widget>
  )
}

const lbl: CSSProperties = { fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-faint)' }
const ctl: CSSProperties = { width: '100%', padding: '7px 8px', fontSize: 13, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', boxSizing: 'border-box' }
const btn: CSSProperties = { padding: '7px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--accent-dim)', color: 'var(--accent)', cursor: 'pointer' }
const th: CSSProperties = { padding: '4px 8px', fontWeight: 600 }
const td: CSSProperties = { padding: '6px 8px', color: 'var(--text)' }

const structBox: CSSProperties = { padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)' }

function humanizeKey(k: string): string {
  return k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// Render a jsonb term value (object/array/primitive) as a readable, read-only
// block. Structured terms (e.g. the verified construction_fee, or the fees
// object) are captured from source and edited via the data layer, so we display
// rather than shove them into a textarea (which showed "[object Object]").
function TermValue({ value }: { value: unknown }): ReactNode {
  if (value == null || value === '') return <span style={{ color: 'var(--text-faint)' }}>—</span>
  if (typeof value !== 'object') return <span>{String(value)}</span>
  if (Array.isArray(value)) {
    return (
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {value.map((item, i) => <li key={i} style={{ fontSize: 13, color: 'var(--text)' }}><TermValue value={item} /></li>)}
      </ul>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
        <div key={k} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', minWidth: 140 }}>{humanizeKey(k)}</span>
          <span style={{ fontSize: 13, color: 'var(--text)', flex: 1, minWidth: 200 }}><TermValue value={v} /></span>
        </div>
      ))}
    </div>
  )
}

function Field({ label, children, filled, inherited }: { label: string; children: ReactNode; filled: boolean; inherited?: boolean }) {
  const color = filled || inherited ? 'var(--text-faint)' : 'var(--warn, #b45309)'
  const marker = filled ? '' : inherited ? ' ◦' : ' •'
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ ...lbl, color }}>{label}{marker}</span>
      {children}
    </label>
  )
}
