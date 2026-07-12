import type { GlPnlData } from '../hooks/useGlPnl'
import type { RentRollData } from '../hooks/useRentRoll'
import type { PropertyLoanRow } from '../hooks/usePropertyHub'
import type { CriticalDateRow } from '../hooks/useDashboard'
import { PdfDownloadButton, sanitizeFilename } from './PdfDownloadButton'

const MONTH = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pctStr = (n: number, dp = 1) => `${(n * 100).toFixed(dp)}%`

// Maps the hook data PropertyDetailPage already loads into the one-pager's
// plain input struct, then renders it. Loose types for deals/agreements —
// only a few display fields are read.
export function PropertyOnePagerButton({ property, pnl, rentRoll, loans, deals, baseMa, currentMa, dates, docCount }: {
  property: {
    name: string
    address: string | null
    city: string | null
    state: string | null
    asset_type: string
    total_sf: number | null
    acquisition_date: string | null
    acquisition_price: number | null
  }
  pnl: GlPnlData | null
  rentRoll: RentRollData | null
  loans: PropertyLoanRow[] | null
  deals: Array<{ name: string; waterfall_tiers?: unknown[] | null; total_equity?: number | null; preferred_equity_positions?: Array<{ principal_amount: number; preferred_rate: number }> | null }>
  baseMa: { manager_name?: string | null; construction_fee_pct?: number | null; leasing_fee_pct?: number | null; monthly_report_due_day?: number | null } | null
  currentMa: { mgmt_fee_pct?: number | null } | null
  dates: CriticalDateRow[] | null
  docCount: number | null
}) {
  return (
    <PdfDownloadButton
      label="⬇ One-Pager"
      filename={`Wilkow-${sanitizeFilename(property.name)}-OnePager.pdf`}
      title="Download a one-page property profile PDF"
      build={async () => {
        const occupancyPct = rentRoll && property.total_sf && property.total_sf > 0 && rentRoll.leasedSf > 0
          ? rentRoll.leasedSf / property.total_sf
          : null

        const { buildPropertyOnePagerPdf } = await import('./PropertyOnePager')
        return buildPropertyOnePagerPdf({
          property: {
            name: property.name,
            address: [property.address, property.city, property.state].filter(Boolean).join(', ') || null,
            assetType: property.asset_type,
            totalSf: property.total_sf,
            acquisitionDate: property.acquisition_date,
            acquisitionPrice: property.acquisition_price,
          },
          kpis: {
            t12Noi: pnl?.t12.noi ?? null,
            t12Revenue: pnl?.t12.revenue ?? null,
            occupancyPct,
            annualRent: rentRoll?.totalAnnualRent ?? null,
            avgPsf: rentRoll?.avgPsf ?? null,
            walt: rentRoll?.walt ?? null,
            rentRollAsOf: rentRoll?.asOf ? `${MONTH[rentRoll.asOf.month]} ${rentRoll.asOf.year}` : null,
            docCount,
          },
          noiTrend: (pnl?.trend ?? []).map(m => ({ label: MONTH[m.month], value: m.noi })),
          topTenants: (rentRoll?.topTenants ?? []).slice(0, 8).map(t => ({
            tenant: t.tenant, sf: t.sf, annualRent: t.annualRent, leaseEnd: t.leaseEnd,
          })),
          loans: (loans ?? []).map(r => ({
            lender: r.loan.lender_name ?? 'Loan',
            balance: r.loan.outstanding_balance,
            rate: r.loan.interest_rate,
            maturity: r.loan.maturity_date,
            dscr: r.dscr,
            debtYield: r.debtYield,
            covenant: r.covenantType === 'debt_yield'
              ? `Debt yield >= ${pctStr(r.loan.debt_yield_covenant ?? 0)}`
              : r.covenantType === 'dscr'
                ? `DSCR >= ${(r.loan.dscr_covenant ?? 0).toFixed(2)}x`
                : null,
            status: r.isBreach ? 'breach' : r.isNear ? 'near' : r.covenantType != null ? 'ok' : 'none',
          })),
          deals: deals.map(d => ({
            name: d.name,
            tiers: (d.waterfall_tiers ?? []).length,
            equity: d.total_equity ?? null,
            prefs: (d.preferred_equity_positions ?? []).map(p =>
              `${Math.abs(p.principal_amount).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })} @ ${pctStr(p.preferred_rate, 2)}`),
          })),
          management: baseMa || currentMa ? {
            manager: baseMa?.manager_name ?? null,
            mgmtFeePct: currentMa?.mgmt_fee_pct ?? null,
            constructionFeePct: baseMa?.construction_fee_pct ?? null,
            leasingFeePct: baseMa?.leasing_fee_pct ?? null,
            reportsDueDay: baseMa?.monthly_report_due_day ?? null,
          } : null,
          criticalDates: (dates ?? []).slice(0, 8).map(d => ({
            label: d.description ?? d.dateType.replace(/_/g, ' '),
            due: d.dueDate,
            days: d.daysUntil,
          })),
          generatedAt: new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }),
        })
      }}
    />
  )
}
