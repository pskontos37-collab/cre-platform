import { useMemo, useState } from 'react'
import { useDeals, type DealRow } from '../hooks/useDeals'
import { useProperties } from '../hooks/useProperties'
import { useGlPnl } from '../hooks/useGlPnl'
import { useRentRoll } from '../hooks/useRentRoll'
import { Widget } from '../components/ui/Widget'
import { InvestorReportButton } from '../reports/InvestorReportButton'
import {
  buildPartyLedgers, quarterlyNet, recentCompleteQuarters,
  type PartyLedger, type QuarterRef,
} from '../lib/distributionLedger'

const usd = (n: number) => {
  const s = Math.abs(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  return n < 0 ? `(${s})` : s
}
const pct = (n: number, dp = 1) => `${(n * 100).toFixed(dp)}%`

// Investor Reporting: the distribution ledger behind every modeled capital
// partnership (actual dated capital_flows — the same history that drives the
// waterfall) plus the one-click quarterly investor report package.
export function InvestorReportingPage() {
  const { data: deals } = useDeals()
  const { data: properties } = useProperties()

  // Only properties that have modeled deals appear here.
  const dealProps = useMemo(() => {
    const ids = [...new Set((deals ?? []).map(d => d.property_id))]
    return ids
      .map(id => (properties ?? []).find(p => p.id === id))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [deals, properties])

  const [propId, setPropId] = useState<string | null>(null)
  const property = dealProps.find(p => p.id === propId) ?? dealProps[0] ?? null

  const propertyIds = useMemo(() => (property ? [property.id] : []), [property?.id])
  const { data: pnl } = useGlPnl(propertyIds)
  const { data: rentRoll } = useRentRoll(propertyIds)

  const propDeals = useMemo(
    () => (deals ?? []).filter(d => d.property_id === property?.id)
      .sort((a, b) => (a.layer ?? 9) - (b.layer ?? 9)),
    [deals, property?.id],
  )

  const quarters = useMemo(() => recentCompleteQuarters(4), [])
  const [qKey, setQKey] = useState(quarters[0].key)
  const quarter = quarters.find(q => q.key === qKey) ?? quarters[0]

  if (!deals) return <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>Loading…</div>

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 4 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>Investor Reporting</h1>
        {property && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <QuarterSelect quarters={quarters} value={qKey} onChange={setQKey} />
            <InvestorReportButton
              property={property}
              quarter={quarter}
              pnl={pnl ?? null}
              rentRoll={rentRoll ?? null}
              deals={propDeals}
            />
          </div>
        )}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 14 }}>
        Actual contributions and distributions per capital partner — the same dated flows that drive the waterfall — with realized returns and the quarterly report package.
      </div>

      {/* Property tabs */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {dealProps.map(p => {
          const active = p.id === property?.id
          return (
            <button
              key={p.id}
              onClick={() => setPropId(p.id)}
              style={{
                fontSize: 12, fontWeight: active ? 650 : 400, padding: '5px 12px', borderRadius: 999,
                border: active ? '1px solid var(--accent)' : '1px solid var(--border-2)',
                background: active ? 'var(--accent-dim)' : 'var(--surface-2)',
                color: active ? 'var(--accent)' : 'var(--text-muted)', cursor: 'pointer',
              }}
            >
              {p.name}
            </button>
          )
        })}
      </div>

      {propDeals.length === 0 && (
        <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>No modeled capital partnerships yet.</div>
      )}

      {propDeals.map(deal => <DealLedger key={deal.id} deal={deal} />)}
    </div>
  )
}

function QuarterSelect({ quarters, value, onChange }: { quarters: QuarterRef[]; value: string; onChange: (k: string) => void }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        background: 'var(--surface-2)', border: '1px solid var(--border-2)', borderRadius: 8,
        color: 'var(--text)', fontSize: 12, padding: '7px 10px',
      }}
    >
      {quarters.map(q => <option key={q.key} value={q.key}>{q.label}</option>)}
    </select>
  )
}

function DealLedger({ deal }: { deal: DealRow }) {
  const ledgers = useMemo(() => buildPartyLedgers(deal), [deal])
  return (
    <div style={{ marginBottom: 20 }}>
      <Widget title={deal.name} chip={deal.layer ? `Layer ${deal.layer}` : undefined}>
        {ledgers.length === 0 ? (
          <div style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>No capital flows recorded for this partnership.</div>
        ) : (
          <>
            {/* party summary cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10, marginBottom: 14 }}>
              {ledgers.map(l => <PartyCard key={`${l.party}|${l.role}`} l={l} />)}
            </div>
            {/* quarterly net table */}
            <QuarterTable ledgers={ledgers} />
            <FlowTable ledgers={ledgers} />
          </>
        )}
      </Widget>
    </div>
  )
}

function PartyCard({ l }: { l: PartyLedger }) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--text)', marginBottom: 8 }}>{l.party}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 6, columnGap: 10 }}>
        <Metric label="Contributed" value={usd(l.contributed)} />
        <Metric label="Distributed" value={usd(l.distributed)} good={l.distributed > 0} />
        <Metric label="DPI" value={l.dpi != null ? `${l.dpi.toFixed(2)}x` : '—'} />
        <Metric label="Realized IRR" value={l.irr != null ? pct(l.irr) : '—'} />
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 8 }}>
        {l.lastDistribution ? `Last distribution ${l.lastDistribution}` : 'No distributions yet'}
      </div>
    </div>
  )
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 9.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-faint)' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 650, color: good ? 'var(--green, #4e8f60)' : 'var(--text)', marginTop: 2 }}>{value}</div>
    </div>
  )
}

function QuarterTable({ ledgers }: { ledgers: PartyLedger[] }) {
  const window = quarterlyNet(ledgers[0].flows, 8)
  return (
    <div style={{ overflowX: 'auto', marginBottom: 6 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
        <thead>
          <tr>
            <th style={th}>Net cash by quarter</th>
            {window.map(q => <th key={q.ref.key} style={{ ...th, textAlign: 'right' }}>{q.ref.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {ledgers.map(l => {
            const cells = quarterlyNet(l.flows, 8)
            return (
              <tr key={`${l.party}|${l.role}`}>
                <td style={{ ...td, color: 'var(--text)' }}>{l.party}</td>
                {cells.map(c => (
                  <td key={c.ref.key} style={{ ...td, textAlign: 'right', color: c.net < 0 ? 'var(--red, #c25b52)' : c.net > 0 ? 'var(--text)' : 'var(--text-faint)' }}>
                    {c.hasFlows ? usd(c.net) : '—'}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function FlowTable({ ledgers }: { ledgers: PartyLedger[] }) {
  const [open, setOpen] = useState(false)
  const flows = useMemo(
    () => ledgers.flatMap(l => l.flows.map(f => ({ ...f, _party: l.party })))
      .sort((a, b) => b.flow_date.localeCompare(a.flow_date)),
    [ledgers],
  )
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ fontSize: 11, color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
      >
        {open ? '▾ Hide flow ledger' : `▸ Show flow ledger (${flows.length} entries)`}
      </button>
      {open && (
        <div style={{ maxHeight: 320, overflowY: 'auto', marginTop: 8, border: '1px solid var(--border)', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr>
                <th style={th}>Date</th><th style={th}>Partner</th>
                <th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}>Source</th>
              </tr>
            </thead>
            <tbody>
              {flows.map(f => (
                <tr key={f.id}>
                  <td style={td}>{f.flow_date}</td>
                  <td style={td}>{f._party}</td>
                  <td style={{ ...td, textAlign: 'right', color: Number(f.amount) < 0 ? 'var(--red, #c25b52)' : 'var(--text)' }}>{usd(Number(f.amount))}</td>
                  <td style={{ ...td, color: 'var(--text-faint)' }}>{f.source ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const th = {
  textAlign: 'left' as const, fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const,
  letterSpacing: '0.05em', color: 'var(--text-faint)', padding: '6px 8px', borderBottom: '1px solid var(--border)',
  position: 'sticky' as const, top: 0, background: 'var(--surface)',
}
const td = {
  padding: '5px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', whiteSpace: 'nowrap' as const,
}
