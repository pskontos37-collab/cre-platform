import { Link, useParams } from 'react-router-dom'
import { useProperties } from '../hooks/useProperties'
import { useAuth } from '../contexts/AuthContext'
import { canSeePage } from '../lib/pages'
import { useTransactions } from '../hooks/useTransactions'
import { TransactionCard } from '../components/transactions/TransactionPieces'
import { useGlPnl } from '../hooks/useGlPnl'
import { useRentRoll } from '../hooks/useRentRoll'
import { useDeals } from '../hooks/useDeals'
import { useManagementAgreements } from '../hooks/useManagementAgreements'
import { useCriticalDates } from '../hooks/useDashboard'
import { useLoansForProperty, usePropertyDocs } from '../hooks/usePropertyHub'
import { useSitePlans } from '../hooks/useSitePlans'
import { viewHref } from '../lib/viewer'
import { Widget, WidgetSkeleton } from '../components/ui/Widget'
import { PropertyOnePagerButton } from '../reports/PropertyOnePagerButton'
import { RentRollPdfButton } from '../reports/RentRollPdfButton'
import { RightsRadar } from '../components/RightsRadar'
import { InvestorReturnsWidget } from '../components/InvestorReturnsWidget'

const usd  = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const pct  = (n: number, dp = 1) => `${(n * 100).toFixed(dp)}%`
const sfmt = (n: number) => Math.round(n).toLocaleString('en-US')
const MONTH = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const DOC_TYPE_LABEL: Record<string, string> = {
  lease: 'Leases', loan_agreement: 'Loan', jv_agreement: 'JV / Entity', psa: 'Purchase & Sale',
  title: 'Title', estoppel: 'Estoppels', inspection: 'Inspections', tax: 'Tax',
  operating_statement: 'Op statements', rent_roll: 'Rent rolls', budget: 'Budgets', other: 'Other',
  site_plan: 'Site plans',
}

export function PropertyDetailPage() {
  const { id = null } = useParams<{ id: string }>()
  const { appUser } = useAuth()
  const { data: properties } = useProperties()
  const property = (properties ?? []).find(p => p.id === id) ?? null

  const canSeeTxns = canSeePage(appUser, 'transactions')
  const { data: allTxns } = useTransactions()
  const txns = canSeeTxns
    ? (allTxns ?? []).filter(t => t.properties.some(p => p.id === id))
    : []

  const propertyIds = id ? [id] : []
  const names = property && id ? { [id]: property.name } : {}

  const { data: pnl }       = useGlPnl(propertyIds)
  const { data: rentRoll }  = useRentRoll(propertyIds)
  const { data: loans }     = useLoansForProperty(id)
  const { data: allDeals }  = useDeals()
  const { data: agreements }= useManagementAgreements(id)
  const { data: dates }     = useCriticalDates(propertyIds, names)
  const { data: docs }      = usePropertyDocs(id)
  const { data: sitePlans } = useSitePlans(id)

  const deals = (allDeals ?? []).filter(d => d.property_id === id)
  const currentMa = (agreements ?? []).filter(a => a.is_current && a.mgmt_fee_pct != null)
    .sort((a, b) => (b.effective_date ?? '').localeCompare(a.effective_date ?? ''))[0] ?? null
  const baseMa = (agreements ?? []).find(a => a.role === 'base') ?? null
  const deadlines = (agreements ?? []).flatMap(a => a.management_agreement_deadlines ?? [])

  if (!property) {
    return (
      <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>
        {properties ? 'Property not found.' : 'Loading…'}{' '}
        <Link to="/properties" style={{ color: 'var(--accent)' }}>Back to properties</Link>
      </div>
    )
  }

  const occupancyPct = rentRoll && property.total_sf && property.total_sf > 0 && rentRoll.leasedSf > 0
    ? rentRoll.leasedSf / property.total_sf
    : null

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ marginBottom: 6 }}>
        <Link to="/properties" style={{ fontSize: 11, color: 'var(--text-faint)', textDecoration: 'none' }}>
          ← Properties
        </Link>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
        <h1 style={{ fontSize: 19, fontWeight: 700, color: 'var(--text)' }}>{property.name}</h1>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
          {[property.address, property.city, property.state].filter(Boolean).join(', ')}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          {property.asset_type.replace('_', ' ')} · {property.total_sf ? `${sfmt(property.total_sf)} SF` : 'SF n/a'}
          {property.acquisition_date ? ` · acquired ${property.acquisition_date}` : ''}
          {property.acquisition_price ? ` for ${usd(property.acquisition_price)}` : ''}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <PropertyOnePagerButton
            property={property}
            pnl={pnl ?? null}
            rentRoll={rentRoll ?? null}
            loans={loans ?? null}
            deals={deals}
            baseMa={baseMa}
            currentMa={currentMa}
            dates={dates ?? null}
            docCount={docs?.total ?? null}
          />
          <RentRollPdfButton
            propertyId={property.id}
            propertyName={property.name}
            totalSf={property.total_sf}
            hasData={!!rentRoll?.asOf}
          />
        </div>
      </div>

      {/* ── KPI strip ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
        <KpiCard label="T12 NOI (GL)" value={pnl && pnl.t12.noi !== 0 ? usd(pnl.t12.noi) : '—'} />
        <KpiCard label="T12 Revenue" value={pnl && pnl.t12.revenue !== 0 ? usd(pnl.t12.revenue) : '—'} />
        <KpiCard label="Occupancy" value={occupancyPct != null ? pct(occupancyPct) : '—'}
                 sub={rentRoll?.asOf ? `${MONTH[rentRoll.asOf.month]} ${rentRoll.asOf.year} roll` : undefined} />
        <KpiCard label="Annual rent" value={rentRoll && rentRoll.totalAnnualRent > 0 ? usd(rentRoll.totalAnnualRent) : '—'}
                 sub={rentRoll && rentRoll.avgPsf > 0 ? `${usd(rentRoll.avgPsf)}/SF` : undefined} />
        <KpiCard label="WALT" value={rentRoll && rentRoll.walt > 0 ? `${rentRoll.walt.toFixed(1)} yrs` : '—'} />
        <KpiCard label="Documents" value={docs ? String(docs.total) : '—'} sub="in corpus" />
      </div>

      {/* ── Transaction history (lifecycle timeline) ── */}
      {canSeeTxns && txns.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
            <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>Transaction History</h2>
            <Link to="/transactions" style={{ fontSize: 11.5, color: 'var(--accent)', textDecoration: 'none' }}>
              All transactions →
            </Link>
          </div>
          {txns.map((t, i) => (
            <TransactionCard key={t.id} t={t} showProperty={false} defaultOpen={i === 0} />
          ))}
        </div>
      )}

      {/* ── Widgets ── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12 }}>

        {/* Site plan */}
        <Widget title="Site Plan" chip={sitePlans && sitePlans.length > 1 ? `${sitePlans.length} on file` : undefined}>
          {!sitePlans ? <WidgetSkeleton /> : sitePlans.length === 0 ? (
            <Empty text="No site plan on file for this property yet." />
          ) : (
            <>
              <div style={{ fontSize: 12.5, color: 'var(--text)', marginBottom: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {(sitePlans[0].fileName ?? 'Site plan').replace(/\.pdf$/i, '')}
                {sitePlans[0].isPrimary && <span style={{ color: 'var(--text-faint)', fontSize: 11 }}> · current</span>}
              </div>
              <div style={{ display: 'flex', gap: 14, fontSize: 12 }}>
                <Link to={`/siteplans?property=${id}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 650 }}>
                  Interactive map →
                </Link>
                {sitePlans[0].signedUrl && (
                  <a href={viewHref(sitePlans[0].signedUrl)} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
                    Open PDF ↗
                  </a>
                )}
              </div>
            </>
          )}
        </Widget>

        {/* NOI trend */}
        <Widget title="NOI Trend" chip={pnl?.latest ? `thru ${MONTH[pnl.latest.month]} ${pnl.latest.year}` : undefined}>
          {!pnl ? <WidgetSkeleton /> : pnl.trend.length === 0 ? (
            <Empty text="No GL loaded for this property yet." />
          ) : (
            <TrendBars data={pnl.trend.map(m => ({ label: `${MONTH[m.month]}`, value: m.noi }))} />
          )}
        </Widget>

        {/* Top tenants */}
        <Widget title="Top Tenants" chip={rentRoll ? `${rentRoll.tenantCount} tenants` : undefined}>
          {!rentRoll ? <WidgetSkeleton /> : rentRoll.topTenants.length === 0 ? (
            <Empty text="No rent roll loaded for this property yet." />
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <tbody>
                {rentRoll.topTenants.slice(0, 8).map((t, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '5px 0', color: 'var(--text)', maxWidth: 180, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.tenant}</td>
                    <td style={{ padding: '5px 0', textAlign: 'right', color: 'var(--text-muted)' }}>{sfmt(t.sf)} SF</td>
                    <td style={{ padding: '5px 0', textAlign: 'right', color: 'var(--text)', fontWeight: 600 }}>{usd(t.annualRent)}</td>
                    <td style={{ padding: '5px 0 5px 10px', textAlign: 'right', color: 'var(--text-faint)', fontSize: 11 }}>{t.leaseEnd ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Widget>

        {/* Debt */}
        <Widget title="Debt & Coverage">
          {!loans ? <WidgetSkeleton /> : loans.length === 0 ? (
            <Empty text="No debt on this property. " />
          ) : loans.map(row => (
            <div key={row.loan.id} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--text)' }}>{row.loan.lender_name ?? 'Loan'}</span>
                <StatusPill isBreach={row.isBreach} isNear={row.isNear} hasCovenant={row.covenantType != null} />
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
                <Fact k="Balance" v={row.loan.outstanding_balance != null ? usd(row.loan.outstanding_balance) : '—'} />
                <Fact k="Rate" v={row.loan.interest_rate != null ? pct(row.loan.interest_rate, 2) : '—'} />
                <Fact k="Maturity" v={row.loan.maturity_date ?? '—'} />
                <Fact k="DSCR" v={row.dscr != null ? `${row.dscr.toFixed(2)}x` : '—'} />
                <Fact k="Debt yield" v={row.debtYield != null ? pct(row.debtYield) : '—'} />
                {row.covenantType && (
                  <Fact k="Covenant" v={row.covenantType === 'debt_yield'
                    ? `DY ≥ ${pct(row.loan.debt_yield_covenant ?? 0)}`
                    : `DSCR ≥ ${(row.loan.dscr_covenant ?? 0).toFixed(2)}x`} />
                )}
              </div>
            </div>
          ))}
        </Widget>

        {/* Equity / waterfall */}
        <Widget title="Equity Structure" chip={deals.length ? `${deals.length} modeled` : undefined}>
          {!allDeals ? <WidgetSkeleton /> : deals.length === 0 ? (
            <Empty text="No waterfall modeled for this property yet." />
          ) : deals.map(d => (
            <div key={d.id} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--text)' }}>{d.name}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 4, fontSize: 11.5, color: 'var(--text-muted)' }}>
                <Fact k="Tiers" v={String((d.waterfall_tiers ?? []).length)} />
                {d.total_equity != null && <Fact k="Equity" v={usd(d.total_equity)} />}
                {(d.preferred_equity_positions ?? []).map(p => (
                  <Fact key={p.id} k="Pref equity" v={`${usd(p.principal_amount)} @ ${pct(p.preferred_rate, 2)}`} />
                ))}
              </div>
            </div>
          ))}
          {deals.length > 0 && (
            <Link to="/waterfall" style={{ fontSize: 11.5, color: 'var(--accent)', textDecoration: 'none' }}>
              Run the waterfall →
            </Link>
          )}
        </Widget>

      </div>

      {/* Investor Returns */}
      {(deals.filter(d => d.layer === 1).length > 0 || deals.filter(d => d.layer === 2).length > 0) && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {deals.filter(d => d.layer === 1).map(d => (
            <InvestorReturnsWidget key={d.id} deal={d} propertyName={property.name} layer={1} />
          ))}

          {deals.filter(d => d.layer === 2).map(d => (
            <InvestorReturnsWidget key={d.id} deal={d} propertyName={property.name} layer={2} />
          ))}
        </div>
      )}

      {/* Management agreement + other bottom widgets */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12, marginTop: 16 }}>
        {/* Management agreement */}
        <Widget title="Property Management" chip={currentMa?.effective_date ? `as of ${currentMa.effective_date}` : undefined}>
          {!agreements ? <WidgetSkeleton /> : agreements.length === 0 ? (
            <Empty text="No management agreement captured yet." />
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 11.5, color: 'var(--text-muted)' }}>
                <Fact k="Manager" v={baseMa?.manager_name ?? '—'} />
                <Fact k="Mgmt fee" v={currentMa?.mgmt_fee_pct != null ? `${currentMa.mgmt_fee_pct}%` : '—'} />
                {baseMa?.construction_fee_pct != null && <Fact k="Constr fee" v={`${baseMa.construction_fee_pct}%`} />}
                {baseMa?.leasing_fee_pct != null && <Fact k="Leasing fee" v={`${baseMa.leasing_fee_pct}%`} />}
                {baseMa?.monthly_report_due_day != null && <Fact k="Reports due" v={`${baseMa.monthly_report_due_day}th`} />}
                <Fact k="Instruments" v={String(agreements.length)} />
              </div>
              {deadlines.length > 0 && (
                <div style={{ marginTop: 10, fontSize: 11.5 }}>
                  {deadlines.slice(0, 4).map(dl => (
                    <div key={dl.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderTop: '1px solid var(--border)' }}>
                      <span style={{ color: 'var(--text)' }}>{dl.label}</span>
                      <span style={{ color: 'var(--text-faint)' }}>{dl.due_rule ?? dl.frequency ?? ''}</span>
                    </div>
                  ))}
                </div>
              )}
              <Link to="/management" style={{ fontSize: 11.5, color: 'var(--accent)', textDecoration: 'none' }}>
                Full agreement terms →
              </Link>
            </>
          )}
        </Widget>

        {/* Documents */}
        <Widget title="Document Corpus" chip={docs ? `${docs.total} docs` : undefined}>
          {!docs ? <WidgetSkeleton /> : docs.total === 0 ? (
            <Empty text="No documents ingested for this property yet." />
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {docs.byType.slice(0, 6).map(t => (
                  <span key={t.doc_type} style={{ fontSize: 10.5, color: 'var(--text-muted)', background: 'var(--surface-2)', padding: '2px 8px', borderRadius: 99 }}>
                    {DOC_TYPE_LABEL[t.doc_type] ?? t.doc_type} · {t.count.toLocaleString()}
                  </span>
                ))}
              </div>
              {docs.recent.slice(0, 5).map(d => (
                <div key={d.id} style={{ padding: '4px 0', borderTop: '1px solid var(--border)', fontSize: 11.5, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {d.title ?? d.file_name ?? d.id}
                </div>
              ))}
              <Link to="/documents" style={{ fontSize: 11.5, color: 'var(--accent)', textDecoration: 'none' }}>
                Search the corpus →
              </Link>
            </>
          )}
        </Widget>

        {/* Critical dates */}
        <Widget title="Critical Dates" chip="next 90 days">
          {!dates ? <WidgetSkeleton /> : dates.length === 0 ? (
            <Empty text="Nothing due in the next 90 days." />
          ) : dates.slice(0, 8).map(d => (
            <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border)', fontSize: 11.5 }}>
              <span style={{ color: 'var(--text)' }}>{d.description ?? d.dateType.replace(/_/g, ' ')}</span>
              <span style={{ color: d.daysUntil <= 14 ? 'var(--danger, #e5484d)' : 'var(--text-faint)', fontWeight: d.daysUntil <= 14 ? 650 : 400 }}>
                {d.dueDate} · {d.daysUntil}d
              </span>
            </div>
          ))}
        </Widget>
      </div>

      {/* Lease rights: co-tenancy clause risk + tenant early-termination rights
          for this property (live RPCs, migration 20240072) */}
      <div style={{ marginTop: 16 }}>
        <RightsRadar propertyIds={propertyIds} propertyNames={names} compact />
      </div>
    </div>
  )
}

// ── Small pieces ──────────────────────────────────────────────────────────────

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px' }}>
      <div style={{ fontSize: 9.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-faint)' }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)', marginTop: 3 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <span>
      <span style={{ color: 'var(--text-faint)' }}>{k}: </span>
      <span style={{ color: 'var(--text)', fontWeight: 600 }}>{v}</span>
    </span>
  )
}

function Empty({ text }: { text: string }) {
  return <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{text}</div>
}

function StatusPill({ isBreach, isNear, hasCovenant }: { isBreach: boolean; isNear: boolean; hasCovenant: boolean }) {
  const [bg, fg, label] = isBreach
    ? ['rgba(229,72,77,0.15)', '#e5484d', 'Breach']
    : isNear
      ? ['rgba(245,159,10,0.15)', '#f59f0a', 'Near covenant']
      : hasCovenant
        ? ['rgba(48,164,108,0.15)', '#30a46c', 'In compliance']
        : ['var(--surface-2)', 'var(--text-faint)', 'No covenant']
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: fg, background: bg, padding: '2px 8px', borderRadius: 99 }}>
      {label}
    </span>
  )
}

function TrendBars({ data }: { data: Array<{ label: string; value: number }> }) {
  const max = Math.max(...data.map(d => Math.abs(d.value)), 1)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 90 }}>
      {data.map((d, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }}>
          <div
            title={`${d.label}: ${usd(d.value)}`}
            style={{
              width:        '100%',
              height:       `${Math.max(4, (Math.abs(d.value) / max) * 70)}px`,
              background:   d.value >= 0 ? 'var(--accent)' : '#e5484d',
              borderRadius: 3,
              opacity:      0.85,
            }}
          />
          <span style={{ fontSize: 8.5, color: 'var(--text-faint)' }}>{d.label}</span>
        </div>
      ))}
    </div>
  )
}
