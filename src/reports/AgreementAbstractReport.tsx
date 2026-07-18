import { Text, View, pdf } from '@react-pdf/renderer'
import { ReportShell } from './ReportShell'
import { GREEN, RULE, TEXT, TEXT_FAINT, TEXT_MUTED, WILKOW, WILKOW_MIST, pdfSafe } from './theme'

// Per-agreement verified-abstract PDF (agreement-abstract output): REAs
// (kind='rea') and JV operating agreements (kind='jv'). Mirrors the on-screen
// AgreementAbstractPanel — the full structured synthesis with verbatim quotes
// + section citations, color-graded open items, and the independent
// verification (agreement-verify) findings. Helvetica body only (SERIF is only
// registered for the shell title).

const RED = '#b3261e'
const AMBER = '#8a6d3b'

export interface AgreementAbstractReportInput {
  kind: 'rea' | 'jv' | 'pma'
  name: string
  abstract: any
  qa?: any | null
  qaStatus?: string | null
  qaAt?: string | null
  generatedAt: string
}

export async function buildAgreementAbstractPdf(input: AgreementAbstractReportInput): Promise<Blob> {
  return pdf(<AgreementAbstractReport {...input} />).toBlob()
}

const str = (v: any): string | null => (typeof v === 'string' && v.trim() ? v : null)

export function AgreementAbstractReport({ kind, name, abstract, qa, qaStatus, qaAt, generatedAt }: AgreementAbstractReportInput) {
  const a = abstract && typeof abstract === 'object' ? abstract : {}
  const kindLabel = kind === 'jv' ? 'Joint-Venture Operating Agreement' : kind === 'pma' ? 'Property Management Agreement' : 'Reciprocal Easement / Recorded Instrument'
  const qaBits = [
    qaStatus ? `verification: ${qaStatus}` : null,
    qaAt ? `checked ${new Date(qaAt).toLocaleDateString('en-US')}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <ReportShell
      orientation="portrait"
      kicker="M&J Wilkow · Verified Abstract"
      title={pdfSafe(name)}
      subtitle={[kindLabel, qaBits].filter(Boolean).join('  ·  ')}
      metaRight={[`Generated ${generatedAt}`]}
    >
      {kind === 'jv' ? <JvBody a={a} /> : kind === 'pma' ? <PmaBody a={a} /> : <ReaBody a={a} />}
      <OpenItems items={Array.isArray(a.open_items) ? a.open_items : []} />
      <Verification qa={qa} />

      <Text style={{ fontSize: 7, color: TEXT_FAINT, marginTop: 8, lineHeight: 1.5 }}>
        {pdfSafe('This abstract is a brief-synthesis of the executed documents and is provided for internal use — consult the source instruments and counsel before relying on any term. Quotations are drawn from the documents cited; open items and verification findings flag where the record is incomplete or in tension.')}
      </Text>
    </ReportShell>
  )
}

// ── PDF primitives ────────────────────────────────────────────────────────────

function Label({ children }: { children: string }) {
  return <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1.2, color: WILKOW_MIST, marginBottom: 3 }}>{children.toUpperCase()}</Text>
}

function Section({ label, children }: { label: string; children: any }) {
  return (
    <View style={{ marginTop: 8 }}>
      <Label>{label}</Label>
      {children}
    </View>
  )
}

function Field({ label, value }: { label: string; value: any }) {
  if (!str(value)) return null
  return (
    <Text style={{ fontSize: 7.5, color: TEXT_MUTED, lineHeight: 1.5, marginBottom: 2 }}>
      <Text style={{ fontFamily: 'Helvetica-Bold', color: WILKOW_MIST }}>{label.toUpperCase()}  </Text>{pdfSafe(value)}
    </Text>
  )
}

function Quote({ text, cite }: { text?: string | null; cite?: string | null }) {
  if (!str(text)) return null
  return (
    <View style={{ marginTop: 2, marginLeft: 6, borderLeftWidth: 1.5, borderLeftColor: RULE, paddingLeft: 6 }}>
      <Text style={{ fontSize: 7, fontFamily: 'Helvetica-Oblique', color: TEXT_MUTED, lineHeight: 1.5 }}>
        {pdfSafe(`"${text}"`)}{cite ? <Text style={{ fontFamily: 'Helvetica', color: TEXT_FAINT }}>{pdfSafe(`  — ${cite}`)}</Text> : null}
      </Text>
    </View>
  )
}

function Card({ children }: { children: any }) {
  return (
    <View wrap={false} style={{ borderBottomWidth: 0.5, borderBottomColor: RULE, paddingVertical: 3 }}>
      {children}
    </View>
  )
}

function Para({ text }: { text?: string | null }) {
  if (!str(text)) return null
  return <Text style={{ fontSize: 7.5, color: TEXT_MUTED, lineHeight: 1.55 }}>{pdfSafe(text)}</Text>
}

function Callout({ label, text }: { label: string; text?: string | null }) {
  if (!str(text)) return null
  return (
    <View style={{ marginTop: 8, backgroundColor: '#eef1f3', borderWidth: 0.75, borderColor: RULE, borderRadius: 3, paddingVertical: 5, paddingHorizontal: 8 }}>
      <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1.2, color: WILKOW, marginBottom: 2 }}>{label.toUpperCase()}</Text>
      <Text style={{ fontSize: 7.5, color: TEXT, lineHeight: 1.55 }}>{pdfSafe(text)}</Text>
    </View>
  )
}

function OpenItems({ items }: { items: string[] }) {
  if (!items.length) return null
  return (
    <Section label={`Open items (${items.length})`}>
      {items.map((raw, i) => {
        const text = String(raw ?? '')
        const red = /^\s*(CONFIRM|DISCREPANCY)\b/i.test(text)
        return (
          <View key={i} wrap={false} style={{ marginBottom: 2.5, marginLeft: 6, borderLeftWidth: 1.5, borderLeftColor: red ? RED : RULE, paddingLeft: 6 }}>
            <Text style={{ fontSize: 7.5, color: red ? TEXT : TEXT_MUTED, lineHeight: 1.5 }}>{pdfSafe(text)}</Text>
          </View>
        )
      })}
    </Section>
  )
}

function AmendmentChain({ chain }: { chain: any }) {
  const items: any[] = Array.isArray(chain) ? chain : []
  if (!items.length) return null
  return (
    <Section label={`Amendment chain (${items.length})`}>
      {items.map((c, i) => (
        <Card key={i}>
          <Text style={{ fontSize: 7.5, lineHeight: 1.5, color: TEXT_MUTED }}>
            <Text style={{ fontFamily: 'Helvetica-Bold', color: TEXT }}>{pdfSafe(str(c.instrument) ?? 'Instrument')}</Text>
            {str(c.date) ? <Text style={{ color: TEXT_FAINT }}>{pdfSafe(`  ·  ${c.date}`)}</Text> : null}
            {str(c.effect) ? pdfSafe(`  ${c.effect}`) : null}
          </Text>
        </Card>
      ))}
    </Section>
  )
}

function CriticalDates({ dates }: { dates: any }) {
  const items: any[] = Array.isArray(dates) ? dates : []
  if (!items.length) return null
  return (
    <Section label={`Critical dates (${items.length})`}>
      {items.map((d, i) => (
        <View key={i} style={{ flexDirection: 'row', marginBottom: 1.5 }}>
          <Text style={{ fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: TEXT, width: 62 }}>{str(d.date) ?? '—'}</Text>
          <Text style={{ fontSize: 7.5, color: TEXT_MUTED, flex: 1, lineHeight: 1.45 }}>
            {pdfSafe(str(d.event) ?? '')}{str(d.source) ? <Text style={{ color: TEXT_FAINT }}>{pdfSafe(`  — ${d.source}`)}</Text> : null}
          </Text>
        </View>
      ))}
    </Section>
  )
}

// ── REA body ────────────────────────────────────────────────────────────────

function ReaBody({ a }: { a: any }) {
  const parties: any[] = Array.isArray(a.parties_parcels) ? a.parties_parcels : []
  const uses: any[] = Array.isArray(a.use_restrictions) ? a.use_restrictions : []
  const covenants: any[] = Array.isArray(a.operating_covenants) ? a.operating_covenants : []
  const exclusives: any[] = Array.isArray(a.exclusives_granted) ? a.exclusives_granted : []
  const approvals: any[] = Array.isArray(a.approval_rights) ? a.approval_rights : []
  const selfHelp: any[] = Array.isArray(a.self_help_remedies) ? a.self_help_remedies : []
  const cs = a.cost_sharing && typeof a.cost_sharing === 'object' ? a.cost_sharing : null
  const term = a.term && typeof a.term === 'object' ? a.term : null

  return (
    <View>
      <Text style={{ fontSize: 7.5, color: TEXT_MUTED, marginTop: 2 }}>
        {pdfSafe([str(a.instrument_type), str(a.original_date), term && str(term.expiration) ? `term: ${term.expiration}` : null].filter(Boolean).join('   ·   '))}
      </Text>
      {str(a.recorded) ? <Text style={{ fontSize: 7, color: TEXT_FAINT, marginTop: 1 }}>{pdfSafe(`Recorded: ${a.recorded}`)}</Text> : null}

      <Callout label="Impact on landlord leasing" text={str(a.impact_on_landlord_leasing)} />

      {parties.length > 0 && (
        <Section label="Parties & parcels">
          {parties.map((p, i) => (
            <Card key={i}>
              <Text style={{ fontSize: 7.5, lineHeight: 1.5 }}>
                <Text style={{ fontFamily: 'Helvetica-Bold', color: TEXT }}>{pdfSafe(str(p.party) ?? '')}</Text>
                {str(p.role) ? <Text style={{ color: TEXT_FAINT }}>{pdfSafe(`  ${p.role}`)}</Text> : null}
              </Text>
              {str(p.parcel) ? <Text style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45 }}>{pdfSafe(p.parcel)}</Text> : null}
              {str(p.current_successor) ? <Text style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45 }}><Text style={{ fontFamily: 'Helvetica-Bold' }}>Now: </Text>{pdfSafe(p.current_successor)}</Text> : null}
            </Card>
          ))}
        </Section>
      )}

      {uses.length > 0 && (
        <Section label="Use restrictions">
          {uses.map((u, i) => (
            <Card key={i}>
              <Text style={{ fontSize: 7.5, color: TEXT }}>{pdfSafe(str(u.scope) ?? '')}{str(u.benefits) ? <Text style={{ color: TEXT_FAINT }}>{pdfSafe(` — benefits ${u.benefits}`)}</Text> : null}</Text>
              <Quote text={str(u.exact_language)} cite={str(u.section)} />
            </Card>
          ))}
        </Section>
      )}

      {covenants.length > 0 && (
        <Section label="Operating covenants">
          {covenants.map((c, i) => (
            <Card key={i}>
              <Text style={{ fontSize: 7.5, color: TEXT }}>{str(c.party) ? <Text style={{ fontFamily: 'Helvetica-Bold' }}>{pdfSafe(`${c.party}: `)}</Text> : null}{pdfSafe(str(c.covenant) ?? '')}{str(c.duration) ? <Text style={{ color: TEXT_FAINT }}>{pdfSafe(` (${c.duration})`)}</Text> : null}</Text>
              <Quote text={str(c.quote)} cite={str(c.section)} />
            </Card>
          ))}
        </Section>
      )}

      {exclusives.length > 0 && (
        <Section label="Exclusives granted">
          {exclusives.map((e, i) => (
            <Card key={i}>
              <Text style={{ fontSize: 7.5, color: TEXT }}>{str(e.holder) ? <Text style={{ fontFamily: 'Helvetica-Bold' }}>{pdfSafe(`${e.holder}: `)}</Text> : null}{pdfSafe(str(e.protection) ?? '')}</Text>
              <Quote text={str(e.quote)} cite={str(e.section)} />
            </Card>
          ))}
        </Section>
      )}

      {cs && (str(cs.common_area_formula) || str(cs.shares) || str(cs.insurance) || (Array.isArray(cs.maintenance) && cs.maintenance.length > 0)) ? (
        <Section label="Cost sharing">
          <Field label="Formula" value={cs.common_area_formula} />
          <Field label="Shares" value={cs.shares} />
          <Field label="Insurance" value={cs.insurance} />
          {(Array.isArray(cs.maintenance) ? cs.maintenance : []).map((m: any, i: number) => (
            <Text key={i} style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45 }}><Text style={{ fontFamily: 'Helvetica-Bold' }}>{pdfSafe(`${str(m.party) ?? ''}: `)}</Text>{pdfSafe(str(m.scope) ?? '')}</Text>
          ))}
        </Section>
      ) : null}

      {approvals.length > 0 && (
        <Section label={`Approval & consent rights (${approvals.length})`}>
          {approvals.map((r, i) => {
            // Tolerant of the pre-enrichment shape {party, right, section}.
            const matter = str(r.matter) ?? str(r.right)
            const approver = str(r.approving_party) ?? str(r.party)
            return (
              <Card key={i}>
                <Text style={{ fontSize: 7.5, lineHeight: 1.5 }}>
                  <Text style={{ fontFamily: 'Helvetica-Bold', color: TEXT }}>{pdfSafe(matter ?? '')}</Text>
                  {str(r.threshold) ? <Text style={{ fontFamily: 'Helvetica-Bold', color: AMBER }}>{pdfSafe(`  ${r.threshold}`)}</Text> : null}
                  {str(r.category) ? <Text style={{ color: TEXT_FAINT }}>{pdfSafe(`  ${String(r.category).replace(/_/g, ' ')}`)}</Text> : null}
                </Text>
                {(approver || str(r.restricted_party)) ? (
                  <Text style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45 }}>
                    {approver ? <Text><Text style={{ fontFamily: 'Helvetica-Bold' }}>approval: </Text>{pdfSafe(approver)}</Text> : null}
                    {str(r.restricted_party) ? <Text style={{ color: TEXT_FAINT }}>{pdfSafe(`${approver ? '  ·  ' : ''}binds ${r.restricted_party}`)}</Text> : null}
                  </Text>
                ) : null}
                {str(r.scope) ? <Text style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45 }}>{pdfSafe(r.scope)}</Text> : null}
                {str(r.deemed_consent) ? <Text style={{ fontSize: 7, color: TEXT_FAINT, lineHeight: 1.45 }}>{pdfSafe(`Deemed consent: ${r.deemed_consent}`)}</Text> : null}
                <Quote text={str(r.quote)} cite={str(r.section)} />
              </Card>
            )
          })}
        </Section>
      )}

      {selfHelp.length > 0 && (
        <Section label="Self-help remedies">
          {selfHelp.map((r, i) => (
            <Text key={i} style={{ fontSize: 7.5, color: TEXT_MUTED, lineHeight: 1.5, marginBottom: 1.5 }}><Text style={{ fontFamily: 'Helvetica-Bold', color: TEXT }}>{pdfSafe(`${str(r.party) ?? ''}: `)}</Text>{pdfSafe(str(r.remedy) ?? '')}</Text>
          ))}
        </Section>
      )}

      {(str(a.building_restrictions?.details) || str(a.parking?.requirements) || str(a.transfer_assignment?.notes) || str(a.estoppel_obligations)) ? (
        <Section label="Other terms">
          <Field label="Building" value={a.building_restrictions?.details} />
          <Field label="Parking" value={a.parking?.requirements} />
          <Field label="Transfer" value={a.transfer_assignment?.notes} />
          <Field label="Estoppel" value={a.estoppel_obligations} />
        </Section>
      ) : null}

      <AmendmentChain chain={a.amendment_chain} />
      <CriticalDates dates={a.critical_dates} />
    </View>
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
    <View>
      {str(a.entity) ? <Text style={{ fontSize: 8, fontFamily: 'Helvetica-Bold', color: TEXT, marginTop: 2 }}>{pdfSafe(a.entity)}</Text> : null}
      <Text style={{ fontSize: 7.5, color: TEXT_MUTED, marginTop: 1 }}>
        {pdfSafe([str(a.agreement_name), str(a.effective_date) ? `effective ${a.effective_date}` : null].filter(Boolean).join('   ·   '))}
      </Text>

      {tiers.length > 0 && (
        <Section label="Distributions waterfall">
          {tiers.map((t, i) => (
            <Card key={i}>
              <Text style={{ fontSize: 7.5, lineHeight: 1.5 }}>
                <Text style={{ fontFamily: 'Helvetica-Bold', color: WILKOW }}>{pdfSafe(`TIER ${t.tier ?? i + 1}  `)}</Text>
                <Text style={{ fontFamily: 'Helvetica-Bold', color: TEXT }}>{pdfSafe(str(t.split) ?? '')}</Text>
                {str(t.hurdle) ? <Text style={{ color: AMBER }}>{pdfSafe(`   hurdle: ${t.hurdle}`)}</Text> : null}
              </Text>
              {str(t.description) ? <Text style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45 }}>{pdfSafe(t.description)}</Text> : null}
              <Quote text={str(t.quote)} cite={str(t.section)} />
            </Card>
          ))}
        </Section>
      )}

      {promote && (str(promote.structure) || str(promote.quote)) ? (
        <Section label="Promote">
          <Para text={str(promote.structure)} />
          <Quote text={str(promote.quote)} cite={str(promote.section)} />
        </Section>
      ) : null}

      {pref && (str(pref.rate) || str(pref.accrues_on)) ? (
        <Section label="Preferred return">
          <Field label="Rate" value={pref.rate} />
          <Field label="Compounding" value={pref.compounding} />
          <Field label="Accrues on" value={pref.accrues_on} />
        </Section>
      ) : null}

      {members.length > 0 && (
        <Section label="Members">
          {members.map((m, i) => (
            <Card key={i}>
              <Text style={{ fontSize: 7.5, lineHeight: 1.5 }}>
                <Text style={{ fontFamily: 'Helvetica-Bold', color: TEXT }}>{pdfSafe(str(m.member) ?? '')}</Text>
                {str(m.role) ? <Text style={{ color: TEXT_FAINT }}>{pdfSafe(`  ${m.role}`)}</Text> : null}
                {m.ownership_pct != null ? <Text style={{ fontFamily: 'Helvetica-Bold', color: WILKOW }}>{pdfSafe(`  ${m.ownership_pct}%`)}</Text> : null}
              </Text>
              {str(m.capital_commitment) ? <Text style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45 }}>{pdfSafe(m.capital_commitment)}</Text> : null}
            </Card>
          ))}
        </Section>
      )}

      {cap && (str(cap.initial_contributions) || cap.capital_calls || str(cap.deferred_commitments)) ? (
        <Section label="Capital">
          <Field label="Initial" value={cap.initial_contributions} />
          {cap.capital_calls && typeof cap.capital_calls === 'object' ? (
            <>
              <Field label="Calls" value={cap.capital_calls.mechanics} />
              <Field label="If a member fails to fund" value={cap.capital_calls.failure_remedy} />
            </>
          ) : null}
          <Field label="Deferred" value={cap.deferred_commitments} />
        </Section>
      ) : null}

      {mgmt && (str(mgmt.manager) || majors.length > 0 || str(mgmt.removal)) ? (
        <Section label="Management & control">
          <Field label="Manager" value={mgmt.manager} />
          <Field label="Removal" value={mgmt.removal} />
          {majors.length > 0 ? (
            <View style={{ marginTop: 2 }}>
              <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', color: TEXT_FAINT, marginBottom: 1 }}>{pdfSafe(`MAJOR DECISIONS (${majors.length})`)}</Text>
              {majors.map((d, i) => <Text key={i} style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.4 }}>{pdfSafe(`•  ${d}`)}</Text>)}
            </View>
          ) : null}
        </Section>
      ) : null}

      {transfer && (str(transfer.rofr_rofo) || str(transfer.consent) || str(transfer.permitted_transfers)) ? (
        <Section label="Transfer restrictions">
          <Field label="ROFR/ROFO" value={transfer.rofr_rofo} />
          <Field label="Consent" value={transfer.consent} />
          <Field label="Permitted" value={transfer.permitted_transfers} />
        </Section>
      ) : null}

      {exit && (str(exit.buy_sell) || str(exit.forced_sale) || str(exit.drag_tag)) ? (
        <Section label="Exit">
          <Field label="Buy/sell" value={exit.buy_sell} />
          <Field label="Forced sale" value={exit.forced_sale} />
          <Field label="Drag/tag" value={exit.drag_tag} />
        </Section>
      ) : null}

      {fees.length > 0 && (
        <Section label="Fees to affiliates">
          {fees.map((f, i) => <Text key={i} style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45, marginBottom: 1.5 }}>{pdfSafe(`•  ${f}`)}</Text>)}
        </Section>
      )}

      {str(a.reporting_tax) ? <Section label="Reporting & tax"><Para text={str(a.reporting_tax)} /></Section> : null}

      <AmendmentChain chain={a.amendment_chain} />
      <CriticalDates dates={a.critical_dates} />
    </View>
  )
}

// ── PMA body ──────────────────────────────────────────────────────────────────

function PmaBody({ a }: { a: any }) {
  const term = a.term && typeof a.term === 'object' ? a.term : null
  const termn = a.termination && typeof a.termination === 'object' ? a.termination : null
  const fees = a.fees && typeof a.fees === 'object' ? a.fees : null
  const reimb = a.reimbursables && typeof a.reimbursables === 'object' ? a.reimbursables : null
  const budget = a.budget && typeof a.budget === 'object' ? a.budget : null
  const appr = a.approvals && typeof a.approvals === 'object' ? a.approvals : null
  const msa = appr?.manager_spending_authority && typeof appr.manager_spending_authority === 'object' ? appr.manager_spending_authority : null
  const ownerReq: any[] = Array.isArray(appr?.owner_approval_required) ? appr.owner_approval_required : []
  const majors: string[] = Array.isArray(appr?.major_decisions) ? appr.major_decisions : []
  const reporting: any[] = Array.isArray(a.reporting) ? a.reporting : []
  const otherFees: any[] = Array.isArray(fees?.other) ? fees.other : []

  return (
    <View>
      {str(a.manager) ? <Text style={{ fontSize: 8, fontFamily: 'Helvetica-Bold', color: TEXT, marginTop: 2 }}>{pdfSafe(a.manager)}{str(a.sub_manager) ? <Text style={{ fontFamily: 'Helvetica', color: TEXT_FAINT }}>{pdfSafe(`  (sub-manager: ${a.sub_manager})`)}</Text> : null}</Text> : null}
      <Text style={{ fontSize: 7.5, color: TEXT_MUTED, marginTop: 1 }}>
        {pdfSafe([str(a.owner) ? `owner: ${a.owner}` : null, str(a.effective_date) ? `effective ${a.effective_date}` : null, term && str(term.end) ? `term to ${term.end}` : null].filter(Boolean).join('   ·   '))}
      </Text>

      {(msa || ownerReq.length > 0 || majors.length > 0) && (
        <View style={{ marginTop: 8, backgroundColor: '#eef1f3', borderWidth: 0.75, borderColor: RULE, borderRadius: 3, paddingVertical: 5, paddingHorizontal: 8 }}>
          <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1.2, color: WILKOW, marginBottom: 3 }}>APPROVALS & SPENDING AUTHORITY</Text>

          {msa && (str(msa.routine_limit) || str(msa.emergency) || str(msa.single_expenditure_limit) || str(msa.annual_or_aggregate_limit) || str(msa.contract_term_or_size_limit) || str(msa.quote)) ? (
            <View style={{ marginBottom: (ownerReq.length > 0 || majors.length > 0) ? 5 : 0 }}>
              <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', color: TEXT_FAINT, marginBottom: 1 }}>MANAGER MAY COMMIT WITHOUT OWNER APPROVAL</Text>
              <Field label="Routine" value={msa.routine_limit} />
              <Field label="Emergency" value={msa.emergency} />
              <Field label="Single expenditure" value={msa.single_expenditure_limit} />
              <Field label="Annual / aggregate" value={msa.annual_or_aggregate_limit} />
              <Field label="Contract term / size" value={msa.contract_term_or_size_limit} />
              <Quote text={str(msa.quote)} cite={str(msa.section)} />
            </View>
          ) : null}

          {ownerReq.length > 0 && (
            <View style={{ marginBottom: majors.length > 0 ? 5 : 0 }}>
              <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', color: TEXT_FAINT, marginBottom: 1 }}>{pdfSafe(`REQUIRES OWNER APPROVAL (${ownerReq.length})`)}</Text>
              {ownerReq.map((r, i) => (
                <View key={i} wrap={false} style={{ marginBottom: 2.5 }}>
                  <Text style={{ fontSize: 7.5, lineHeight: 1.5 }}>
                    <Text style={{ fontFamily: 'Helvetica-Bold', color: TEXT }}>{pdfSafe(str(r.matter) ?? '')}</Text>
                    {str(r.threshold) ? <Text style={{ fontFamily: 'Helvetica-Bold', color: AMBER }}>{pdfSafe(`  ${r.threshold}`)}</Text> : null}
                    {str(r.category) ? <Text style={{ color: TEXT_FAINT }}>{pdfSafe(`  ${String(r.category).replace(/_/g, ' ')}`)}</Text> : null}
                  </Text>
                  {str(r.scope) ? <Text style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45 }}>{pdfSafe(r.scope)}</Text> : null}
                  <Quote text={str(r.quote)} cite={str(r.section)} />
                </View>
              ))}
            </View>
          )}

          {majors.length > 0 && (
            <View>
              <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', color: TEXT_FAINT, marginBottom: 1 }}>{pdfSafe(`MAJOR DECISIONS RESERVED TO OWNER (${majors.length})`)}</Text>
              {majors.map((d, i) => <Text key={i} style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.4 }}>{pdfSafe(`•  ${d}`)}</Text>)}
            </View>
          )}

          {str(appr?.notes) ? <Text style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45, marginTop: 3 }}>{pdfSafe(appr.notes)}</Text> : null}
        </View>
      )}

      {fees && (
        <Section label="Fees">
          {fees.management && (fees.management.pct != null || str(fees.management.base) || str(fees.management.minimum)) ? (
            <Text style={{ fontSize: 7.5, color: TEXT_MUTED, lineHeight: 1.5, marginBottom: 1.5 }}>
              <Text style={{ fontFamily: 'Helvetica-Bold', color: TEXT }}>Management  </Text>
              {pdfSafe([fees.management.pct != null ? `${fees.management.pct}%` : null, str(fees.management.base), str(fees.management.minimum) ? `min ${fees.management.minimum}` : null].filter(Boolean).join('  ·  '))}
            </Text>
          ) : null}
          {fees.construction && (fees.construction.pct != null || str(fees.construction.basis)) ? (
            <Text style={{ fontSize: 7.5, color: TEXT_MUTED, lineHeight: 1.5, marginBottom: 1.5 }}>
              <Text style={{ fontFamily: 'Helvetica-Bold', color: TEXT }}>Construction  </Text>
              {pdfSafe([fees.construction.pct != null ? `${fees.construction.pct}%` : null, str(fees.construction.basis)].filter(Boolean).join('  ·  '))}
            </Text>
          ) : null}
          {fees.leasing && str(fees.leasing.terms) ? <Field label="Leasing" value={fees.leasing.terms} /> : null}
          {otherFees.map((f, i) => (
            <Text key={i} style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45, marginBottom: 1 }}><Text style={{ fontFamily: 'Helvetica-Bold' }}>{pdfSafe(`${str(f.fee) ?? ''}: `)}</Text>{pdfSafe(str(f.terms) ?? '')}</Text>
          ))}
        </Section>
      )}

      {termn && (termn.for_convenience?.notice_days != null || str(termn.for_convenience?.who) || str(termn.for_cause) || str(termn.on_sale) || str(termn.fees_on_termination)) ? (
        <Section label="Termination">
          {termn.for_convenience && (str(termn.for_convenience.who) || termn.for_convenience.notice_days != null) ? (
            <Field label="For convenience" value={[str(termn.for_convenience.who), termn.for_convenience.notice_days != null ? `${termn.for_convenience.notice_days} days notice` : null].filter(Boolean).join('  ·  ')} />
          ) : null}
          <Field label="For cause" value={termn.for_cause} />
          <Field label="On sale" value={termn.on_sale} />
          <Field label="Termination fees" value={termn.fees_on_termination} />
        </Section>
      ) : null}

      {budget && (str(budget.approval) || str(budget.variance_authority)) ? (
        <Section label="Budget">
          <Field label="Approval" value={budget.approval} />
          <Field label="Permitted variance" value={budget.variance_authority} />
        </Section>
      ) : null}

      {reimb && (str(reimb.included) || str(reimb.excluded)) ? (
        <Section label="Reimbursables">
          <Field label="Included" value={reimb.included} />
          <Field label="Excluded" value={reimb.excluded} />
        </Section>
      ) : null}

      {reporting.length > 0 && (
        <Section label="Reporting">
          {reporting.map((r, i) => (
            <Text key={i} style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45, marginBottom: 1 }}>
              <Text style={{ fontFamily: 'Helvetica-Bold', color: TEXT }}>{pdfSafe(str(r.report) ?? '')}</Text>{str(r.due) ? pdfSafe(` — due ${r.due}`) : null}
            </Text>
          ))}
        </Section>
      )}

      <AmendmentChain chain={a.amendment_chain} />
      <CriticalDates dates={a.critical_dates} />
    </View>
  )
}

// ── verification findings (agreement-verify) ─────────────────────────────────

function Verification({ qa }: { qa: any }) {
  if (!qa || typeof qa !== 'object') return null
  const checks: any[] = Array.isArray(qa.field_checks) ? qa.field_checks : []
  const flagged = checks.filter(c => c?.verdict && c.verdict !== 'confirmed')
  const recon: any[] = Array.isArray(qa.tracker_reconciliation) ? qa.tracker_reconciliation : []
  const fixes: string[] = Array.isArray(qa.recommended_fixes) ? qa.recommended_fixes : []
  if (!str(qa.summary) && !flagged.length && !recon.length && !fixes.length) return null

  return (
    <View style={{ marginTop: 10, borderTopWidth: 0.75, borderTopColor: RULE, paddingTop: 6 }}>
      <Label>Independent verification</Label>
      <Para text={str(qa.summary)} />

      {flagged.map((c, i) => {
        const red = c.verdict === 'discrepancy' || c.verdict === 'unsupported'
        return (
          <View key={i} wrap={false} style={{ marginTop: 4 }}>
            <Text style={{ fontSize: 7.5, lineHeight: 1.5 }}>
              <Text style={{ fontFamily: 'Helvetica-Bold', color: red ? RED : AMBER }}>{pdfSafe(`${String(c.verdict).toUpperCase()}  `)}</Text>
              <Text style={{ fontFamily: 'Helvetica-Bold', color: TEXT }}>{pdfSafe(str(c.field) ?? '')}</Text>
              {str(c.severity) ? <Text style={{ color: TEXT_FAINT }}>{pdfSafe(`  (${c.severity})`)}</Text> : null}
            </Text>
            {str(c.note) ? <Text style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45 }}>{pdfSafe(c.note)}</Text> : null}
            <Quote text={str(c.source_quote)} cite={str(c.citation)} />
          </View>
        )
      })}

      {recon.length > 0 && (
        <View style={{ marginTop: 6 }}>
          <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1, color: WILKOW, marginBottom: 2 }}>{pdfSafe(`TRACKER RECONCILIATION (${recon.length})`)}</Text>
          {recon.map((m, i) => (
            <View key={i} wrap={false} style={{ marginBottom: 2.5 }}>
              <Text style={{ fontSize: 7.5, lineHeight: 1.5 }}>
                <Text style={{ fontFamily: 'Helvetica-Bold', color: TEXT }}>{pdfSafe(str(m.field) ?? '')}</Text>
                {m.governs ? <Text style={{ fontFamily: 'Helvetica-Bold', color: m.governs === 'abstract' ? RED : TEXT_FAINT }}>{pdfSafe(m.governs === 'abstract' ? '  documents govern — update tracker' : m.governs === 'tracker' ? '  tracker correct' : '  unclear')}</Text> : null}
              </Text>
              <Text style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45 }}>{pdfSafe(`Documents: ${m.abstract_value ?? '—'}  ·  Tracker: ${m.tracker_value ?? '—'}`)}</Text>
              {str(m.note) ? <Text style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45 }}>{pdfSafe(m.note)}</Text> : null}
            </View>
          ))}
        </View>
      )}

      {fixes.length > 0 && (
        <View style={{ marginTop: 6 }}>
          <Text style={{ fontSize: 6.5, fontFamily: 'Helvetica-Bold', letterSpacing: 1, color: WILKOW, marginBottom: 2 }}>RECOMMENDED FIXES</Text>
          {fixes.map((x, i) => <Text key={i} style={{ fontSize: 7, color: TEXT_MUTED, lineHeight: 1.45, marginBottom: 1.5 }}>{pdfSafe(`•  ${x}`)}</Text>)}
        </View>
      )}
      {str(qaGreenNote(qa)) ? <Text style={{ fontSize: 7, color: GREEN, marginTop: 4 }}>{pdfSafe(qaGreenNote(qa)!)}</Text> : null}
    </View>
  )
}

function qaGreenNote(qa: any): string | null {
  const checks: any[] = Array.isArray(qa.field_checks) ? qa.field_checks : []
  const confirmed = checks.filter(c => c?.verdict === 'confirmed').length
  return confirmed > 0 ? `${confirmed} field${confirmed === 1 ? '' : 's'} confirmed against the source documents.` : null
}
