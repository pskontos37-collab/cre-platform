import { useState, type ReactNode, type CSSProperties } from 'react'

// Verified-abstract surface for the agreement-abstract edge function output:
// REAs (kind='rea', rea_agreements.abstract) and JV operating agreements
// (kind='jv', deals.abstract). Collapsed by default behind a "Verified
// abstract" toggle; opens to the full structured synthesis with verbatim
// quotes + instrument/section citations. Open items are color-graded by the
// generator's prefix convention (CONFIRM:/DISCREPANCY: = red), matching the
// lease-abstract worklist vocabulary. Pair with AgreementQaPanel for the
// independent verification verdict.

export function AgreementAbstractPanel({ kind, abstract }: {
  kind: 'rea' | 'jv'; abstract: any
}) {
  const [open, setOpen] = useState(false)
  if (!abstract || typeof abstract !== 'object') return null
  const openItems: string[] = Array.isArray(abstract.open_items) ? abstract.open_items : []

  return (
    <div style={{ marginTop: 10, border: '1px solid var(--border-2)', borderRadius: 9, overflow: 'hidden' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--surface-2)', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
          Verified abstract
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {kind === 'jv' ? 'operating-agreement synthesis' : 'recorded-instrument synthesis'}
        </span>
        {openItems.length > 0 && (
          <span style={{ fontSize: 9.5, fontWeight: 700, padding: '1px 7px', borderRadius: 9, color: 'var(--amber)', background: 'rgba(245,158,11,0.12)' }}>
            {openItems.length} open item{openItems.length === 1 ? '' : 's'}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'var(--accent)' }}>
          {open ? 'Hide ▾' : 'View ▸'}
        </span>
      </button>
      {open && (
        <div style={{ padding: '12px 14px', background: 'var(--surface)' }}>
          {kind === 'jv' ? <JvBody a={abstract} /> : <ReaBody a={abstract} />}
          {openItems.length > 0 && <OpenItems items={openItems} />}
        </div>
      )}
    </div>
  )
}

// ── shared primitives ──────────────────────────────────────────────────────

const sectionLbl: CSSProperties = {
  fontSize: 9.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
  color: 'var(--text-faint)', marginBottom: 6,
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={sectionLbl}>{label}</div>
      {children}
    </div>
  )
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  if (value == null || value === '') return null
  return (
    <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 4 }}>
      <span style={{ fontSize: 9.5, fontWeight: 650, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-faint)', marginRight: 7 }}>{label}</span>
      {value}
    </div>
  )
}

function Quote({ text, cite }: { text?: string | null; cite?: string | null }) {
  if (!text) return null
  return (
    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 3, paddingLeft: 9, borderLeft: '2px solid var(--border-2)', fontStyle: 'italic', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
      “{text}”{cite ? <span style={{ fontStyle: 'normal', color: 'var(--text-faint)' }}> — {cite}</span> : null}
    </div>
  )
}

// One boxed entry per array element.
function Card({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: '7px 10px', background: 'var(--surface-2)', borderRadius: 7, marginBottom: 6 }}>
      {children}
    </div>
  )
}

// A callout for the single most decision-relevant narrative (leasing impact).
function Callout({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 14, padding: '10px 12px', background: 'var(--accent-soft, rgba(59,130,246,0.09))', border: '1px solid var(--border-2)', borderRadius: 8 }}>
      <div style={{ ...sectionLbl, color: 'var(--accent)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.6 }}>{children}</div>
    </div>
  )
}

function OpenItems({ items }: { items: string[] }) {
  return (
    <div style={{ marginTop: 4 }}>
      <div style={sectionLbl}>Open items ({items.length})</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {items.map((raw, i) => {
          const text = String(raw ?? '')
          // Same prefix convention as the lease-abstract worklist: CONFIRM /
          // DISCREPANCY demand attention (red); MISSING FROM FILE / notes are neutral.
          const red = /^\s*(CONFIRM|DISCREPANCY)\b/i.test(text)
          const m = text.match(/^\s*([A-Z][A-Z ]{2,}?):\s*/)
          const tag = m ? m[1].trim() : null
          const body = m ? text.slice(m[0].length) : text
          return (
            <div key={i} style={{ fontSize: 11.5, color: 'var(--text-muted)', lineHeight: 1.5, paddingLeft: 8, borderLeft: `2px solid ${red ? 'var(--red, #ef4444)' : 'var(--border-2)'}` }}>
              {tag && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.04em', color: red ? 'var(--red, #ef4444)' : 'var(--text-faint)', marginRight: 6 }}>{tag}</span>}
              {body}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const str = (v: any): string | null => (typeof v === 'string' && v.trim() ? v : null)

// ── REA body ────────────────────────────────────────────────────────────────

function ReaBody({ a }: { a: any }) {
  const parties: any[] = Array.isArray(a.parties_parcels) ? a.parties_parcels : []
  const covenants: any[] = Array.isArray(a.operating_covenants) ? a.operating_covenants : []
  const uses: any[] = Array.isArray(a.use_restrictions) ? a.use_restrictions : []
  const exclusives: any[] = Array.isArray(a.exclusives_granted) ? a.exclusives_granted : []
  const approvals: any[] = Array.isArray(a.approval_rights) ? a.approval_rights : []
  const selfHelp: any[] = Array.isArray(a.self_help_remedies) ? a.self_help_remedies : []
  const cs = a.cost_sharing && typeof a.cost_sharing === 'object' ? a.cost_sharing : null
  const term = a.term && typeof a.term === 'object' ? a.term : null

  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        {[str(a.instrument_type), str(a.original_date), term ? str(term.expiration) && `term: ${term.expiration}` : null]
          .filter(Boolean).join('  ·  ')}
        {str(a.recorded) && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>Recorded: {a.recorded}</div>}
      </div>

      {str(a.impact_on_landlord_leasing) && (
        <Callout label="Impact on landlord leasing">{a.impact_on_landlord_leasing}</Callout>
      )}

      {parties.length > 0 && (
        <Section label="Parties & parcels">
          {parties.map((p, i) => (
            <Card key={i}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                {str(p.party)}{str(p.role) && <span style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--text-faint)', marginLeft: 8 }}>{p.role}</span>}
              </div>
              {str(p.parcel) && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{p.parcel}</div>}
              {str(p.current_successor) && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}><b>Now:</b> {p.current_successor}</div>}
              {str(p.notes) && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>{p.notes}</div>}
            </Card>
          ))}
        </Section>
      )}

      {uses.length > 0 && (
        <Section label="Use restrictions">
          {uses.map((u, i) => (
            <Card key={i}>
              <div style={{ fontSize: 12, color: 'var(--text)' }}>{str(u.scope)}{str(u.benefits) && <span style={{ color: 'var(--text-faint)' }}> — benefits {u.benefits}</span>}</div>
              <Quote text={str(u.exact_language)} cite={str(u.section)} />
            </Card>
          ))}
        </Section>
      )}

      {covenants.length > 0 && (
        <Section label="Operating covenants">
          {covenants.map((c, i) => (
            <Card key={i}>
              <div style={{ fontSize: 12, color: 'var(--text)' }}>
                {str(c.party) && <b>{c.party}: </b>}{str(c.covenant)}{str(c.duration) && <span style={{ color: 'var(--text-faint)' }}> ({c.duration})</span>}
              </div>
              <Quote text={str(c.quote)} cite={str(c.section)} />
            </Card>
          ))}
        </Section>
      )}

      {exclusives.length > 0 && (
        <Section label="Exclusives granted">
          {exclusives.map((e, i) => (
            <Card key={i}>
              <div style={{ fontSize: 12, color: 'var(--text)' }}>{str(e.holder) && <b>{e.holder}: </b>}{str(e.protection)}</div>
              <Quote text={str(e.quote)} cite={str(e.section)} />
            </Card>
          ))}
        </Section>
      )}

      {cs && (str(cs.common_area_formula) || str(cs.shares) || str(cs.insurance) || (Array.isArray(cs.maintenance) && cs.maintenance.length > 0)) && (
        <Section label="Cost sharing">
          <Field label="Formula" value={str(cs.common_area_formula)} />
          <Field label="Shares" value={str(cs.shares)} />
          <Field label="Insurance" value={str(cs.insurance)} />
          {Array.isArray(cs.maintenance) && cs.maintenance.map((m: any, i: number) => (
            <div key={i} style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
              <b>{str(m.party)}:</b> {str(m.scope)}{str(m.section) && <span style={{ color: 'var(--text-faint)' }}> — {m.section}</span>}
            </div>
          ))}
        </Section>
      )}

      {approvals.length > 0 && (
        <Section label="Approval rights">
          {approvals.map((r, i) => (
            <div key={i} style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 3 }}>
              <b>{str(r.party)}:</b> {str(r.right)}{str(r.section) && <span style={{ color: 'var(--text-faint)' }}> — {r.section}</span>}
            </div>
          ))}
        </Section>
      )}

      {selfHelp.length > 0 && (
        <Section label="Self-help remedies">
          {selfHelp.map((r, i) => (
            <div key={i} style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 3 }}>
              <b>{str(r.party)}:</b> {str(r.remedy)}{str(r.section) && <span style={{ color: 'var(--text-faint)' }}> — {r.section}</span>}
            </div>
          ))}
        </Section>
      )}

      <MiscFields fields={[
        ['Building restrictions', a.building_restrictions?.details],
        ['Parking', a.parking?.requirements],
        ['Transfer / assignment', a.transfer_assignment?.notes],
        ['Estoppel obligations', a.estoppel_obligations],
      ]} />

      <AmendmentChain chain={a.amendment_chain} />
      <CriticalDates dates={a.critical_dates} />
    </>
  )
}

// ── JV body ──────────────────────────────────────────────────────────────────

function JvBody({ a }: { a: any }) {
  const members: any[] = Array.isArray(a.parties_members) ? a.parties_members : []
  const tiers: any[] = Array.isArray(a.distributions_waterfall) ? a.distributions_waterfall : []
  const pref = a.preferred_return && typeof a.preferred_return === 'object' ? a.preferred_return : null
  const promote = a.promote && typeof a.promote === 'object' ? a.promote : null
  const cap = a.capital && typeof a.capital === 'object' ? a.capital : null
  const mgmt = a.management_control && typeof a.management_control === 'object' ? a.management_control : null
  const transfer = a.transfer_restrictions && typeof a.transfer_restrictions === 'object' ? a.transfer_restrictions : null
  const exit = a.exit && typeof a.exit === 'object' ? a.exit : null
  const fees: string[] = Array.isArray(a.fees_to_affiliates) ? a.fees_to_affiliates : []
  const majors: string[] = Array.isArray(mgmt?.major_decisions) ? mgmt.major_decisions : []

  return (
    <>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        {str(a.entity) && <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>{a.entity}</div>}
        {[str(a.agreement_name), str(a.effective_date) && `effective ${a.effective_date}`].filter(Boolean).join('  ·  ')}
      </div>

      {tiers.length > 0 && (
        <Section label="Distributions waterfall">
          {tiers.map((t, i) => (
            <Card key={i}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent)' }}>TIER {t.tier ?? i + 1}</span>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{str(t.split)}</span>
                {str(t.hurdle) && <span style={{ fontSize: 10.5, color: 'var(--amber)' }}>hurdle: {t.hurdle}</span>}
              </div>
              {str(t.description) && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{t.description}</div>}
              <Quote text={str(t.quote)} cite={str(t.section)} />
            </Card>
          ))}
        </Section>
      )}

      {promote && (str(promote.structure) || str(promote.quote)) && (
        <Section label="Promote">
          <div style={{ fontSize: 12, color: 'var(--text)' }}>{str(promote.structure)}</div>
          <Quote text={str(promote.quote)} cite={str(promote.section)} />
        </Section>
      )}

      {pref && (str(pref.rate) || str(pref.accrues_on)) && (
        <Section label="Preferred return">
          <Field label="Rate" value={str(pref.rate)} />
          <Field label="Compounding" value={str(pref.compounding)} />
          <Field label="Accrues on" value={str(pref.accrues_on)} />
          {str(pref.section) && <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{pref.section}</div>}
        </Section>
      )}

      {members.length > 0 && (
        <Section label="Members">
          {members.map((m, i) => (
            <Card key={i}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                {str(m.member)}
                {str(m.role) && <span style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--text-faint)', marginLeft: 8 }}>{m.role}</span>}
                {m.ownership_pct != null && <span style={{ fontSize: 11.5, fontWeight: 650, color: 'var(--accent)', marginLeft: 8 }}>{m.ownership_pct}%</span>}
              </div>
              {str(m.capital_commitment) && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>{m.capital_commitment}</div>}
              {str(m.notes) && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>{m.notes}</div>}
            </Card>
          ))}
        </Section>
      )}

      {cap && (str(cap.initial_contributions) || cap.capital_calls || str(cap.deferred_commitments)) && (
        <Section label="Capital">
          <Field label="Initial" value={str(cap.initial_contributions)} />
          {cap.capital_calls && typeof cap.capital_calls === 'object' && (
            <>
              <Field label="Calls" value={str(cap.capital_calls.mechanics)} />
              <Field label="If a member fails to fund" value={str(cap.capital_calls.failure_remedy)} />
            </>
          )}
          <Field label="Deferred commitments" value={str(cap.deferred_commitments)} />
        </Section>
      )}

      {mgmt && (str(mgmt.manager) || majors.length > 0 || str(mgmt.removal)) && (
        <Section label="Management & control">
          <Field label="Manager" value={str(mgmt.manager)} />
          <Field label="Removal" value={str(mgmt.removal)} />
          {majors.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div style={{ fontSize: 9.5, fontWeight: 650, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: 3 }}>Major decisions ({majors.length})</div>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {majors.map((d, i) => <li key={i} style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 1 }}>{d}</li>)}
              </ul>
            </div>
          )}
        </Section>
      )}

      {transfer && (str(transfer.rofr_rofo) || str(transfer.consent) || str(transfer.permitted_transfers)) && (
        <Section label="Transfer restrictions">
          <Field label="ROFR / ROFO" value={str(transfer.rofr_rofo)} />
          <Field label="Consent" value={str(transfer.consent)} />
          <Field label="Permitted" value={str(transfer.permitted_transfers)} />
        </Section>
      )}

      {exit && (str(exit.buy_sell) || str(exit.forced_sale) || str(exit.drag_tag)) && (
        <Section label="Exit">
          <Field label="Buy/sell" value={str(exit.buy_sell)} />
          <Field label="Forced sale" value={str(exit.forced_sale)} />
          <Field label="Drag / tag" value={str(exit.drag_tag)} />
        </Section>
      )}

      {fees.length > 0 && (
        <Section label="Fees to affiliates">
          <ul style={{ margin: 0, paddingLeft: 16 }}>
            {fees.map((f, i) => <li key={i} style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 3, lineHeight: 1.5 }}>{f}</li>)}
          </ul>
        </Section>
      )}

      <MiscFields fields={[['Reporting & tax', a.reporting_tax]]} />
      <AmendmentChain chain={a.amendment_chain} />
      <CriticalDates dates={a.critical_dates} />
    </>
  )
}

// ── shared tail sections ─────────────────────────────────────────────────────

function MiscFields({ fields }: { fields: [string, any][] }) {
  const shown = fields.filter(([, v]) => str(v))
  if (shown.length === 0) return null
  return (
    <>
      {shown.map(([label, v]) => (
        <Section key={label} label={label}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>{v}</div>
        </Section>
      ))}
    </>
  )
}

function AmendmentChain({ chain }: { chain: any }) {
  const items: any[] = Array.isArray(chain) ? chain : []
  if (items.length === 0) return null
  return (
    <Section label={`Amendment chain (${items.length})`}>
      {items.map((c, i) => (
        <div key={i} style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 4, lineHeight: 1.5 }}>
          <b style={{ color: 'var(--text)' }}>{str(c.instrument) ?? 'Instrument'}</b>
          {str(c.date) && <span style={{ color: 'var(--text-faint)' }}> · {c.date}</span>}
          {str(c.effect) && <div style={{ marginTop: 1 }}>{c.effect}</div>}
        </div>
      ))}
    </Section>
  )
}

function CriticalDates({ dates }: { dates: any }) {
  const items: any[] = Array.isArray(dates) ? dates : []
  if (items.length === 0) return null
  return (
    <Section label={`Critical dates (${items.length})`}>
      {items.map((d, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 2, lineHeight: 1.45 }}>
          <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap' }}>{str(d.date) ?? '—'}</span>
          <span>{str(d.event)}{str(d.source) && <span style={{ color: 'var(--text-faint)' }}> — {d.source}</span>}</span>
        </div>
      ))}
    </Section>
  )
}
