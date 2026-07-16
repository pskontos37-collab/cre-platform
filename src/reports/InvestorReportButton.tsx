import type { GlPnlData } from '../hooks/useGlPnl'
import type { RentRollData } from '../hooks/useRentRoll'
import type { DealRow } from '../hooks/useDeals'
import { buildPartyLedgers, distributedInWindow, type QuarterRef } from '../lib/distributionLedger'
import { PdfDownloadButton, sanitizeFilename } from './PdfDownloadButton'

const MONTH = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// Assembles the quarterly investor report input from the hook data the
// /investors page already loads, then renders it (report module is
// dynamic-imported so @react-pdf stays out of the main bundle).
export function InvestorReportButton({ property, quarter, pnl, rentRoll, deals }: {
  property: { id: string; name: string; city: string | null; state: string | null; asset_type: string; total_sf: number | null }
  quarter: QuarterRef
  pnl: GlPnlData | null
  rentRoll: RentRollData | null
  deals: DealRow[]
}) {
  return (
    <PdfDownloadButton
      label={`⬇ ${quarter.label} Investor Report`}
      filename={`Wilkow-${sanitizeFilename(property.name)}-Investor-Report-${quarter.key}.pdf`}
      title="Download the quarterly investor report PDF"
      build={async () => {
        const inQuarter = (m: { year: number; month: number }) =>
          m.year === quarter.year && quarter.months.includes(m.month)
        const months = (pnl?.trend ?? []).filter(inQuarter)
        const qRevenue = months.reduce((s, m) => s + m.revenue, 0)
        const qOpex = months.reduce((s, m) => s + m.opex, 0)
        const qNoi = months.reduce((s, m) => s + m.noi, 0)

        // prior quarter NOI from the same trend window, when fully present
        const prevQ = quarter.quarter === 1
          ? { year: quarter.year - 1, months: [10, 11, 12] }
          : { year: quarter.year, months: quarter.months.map(m => m - 3) }
        const prevMonths = (pnl?.trend ?? []).filter(m => m.year === prevQ.year && prevQ.months.includes(m.month))
        const prevQNoi = prevMonths.length === 3 ? prevMonths.reduce((s, m) => s + m.noi, 0) : null

        const ytdStart = `${quarter.year}-01-01`
        const partnerships = deals.map(d => {
          const ledgers = buildPartyLedgers(d)
          return {
            dealName: d.name,
            layer: d.layer,
            parties: ledgers.map(l => ({
              name: l.party,
              contributed: l.contributed,
              qDistributed: distributedInWindow(l.flows, quarter.start, quarter.end),
              ytdDistributed: distributedInWindow(l.flows, ytdStart, quarter.end),
              cumDistributed: l.distributed,
              dpi: l.dpi,
              irr: l.irr,
              lastDistribution: l.lastDistribution,
            })),
          }
        })

        const { buildInvestorReportPdf } = await import('./InvestorReport')
        return buildInvestorReportPdf({
          property: {
            name: property.name,
            location: [property.city, property.state].filter(Boolean).join(', ') || null,
            assetType: property.asset_type,
            totalSf: property.total_sf,
          },
          quarter: { label: quarter.label, start: quarter.start, end: quarter.end },
          financials: {
            months: months.map(m => ({ label: `${MONTH[m.month]} ${m.year}`, revenue: m.revenue, opex: m.opex, noi: m.noi })),
            qRevenue, qOpex, qNoi, prevQNoi,
            t12Noi: pnl?.t12.noi ?? 0,
            hasGl: months.length > 0,
          },
          leasing: {
            occupancyPct: rentRoll && rentRoll.totalGla > 0 && rentRoll.leasedSf > 0 ? rentRoll.leasedSf / rentRoll.totalGla : null,
            walt: rentRoll?.walt ?? null,
            tenantCount: rentRoll?.tenantCount ?? null,
            avgPsf: rentRoll?.avgPsf ?? null,
            annualRent: rentRoll?.totalAnnualRent ?? null,
            asOfLabel: rentRoll?.asOf ? `${MONTH[rentRoll.asOf.month]} ${rentRoll.asOf.year}` : null,
          },
          topTenants: (rentRoll?.topTenants ?? []).slice(0, 10),
          rollover: (rentRoll?.rollover ?? []).slice(0, 5).map(r => ({ year: r.year, sf: r.sf, pct: r.pct })),
          partnerships,
          generatedAt: new Date().toLocaleDateString('en-US', { dateStyle: 'long' }),
        })
      }}
    />
  )
}
