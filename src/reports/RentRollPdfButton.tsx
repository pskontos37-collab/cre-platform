import { supabase } from '../lib/supabase'
import { computeWALT } from '../lib/financials'
import { PdfDownloadButton, sanitizeFilename } from './PdfDownloadButton'

const MONTH = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// Fetches the latest rent-roll snapshot's rows on click, then renders the
// branded rent roll PDF. `hasData` should reflect whether the property has a
// snapshot at all (the page already knows via useRentRoll).
export function RentRollPdfButton({ propertyId, propertyName, totalSf, hasData }: {
  propertyId: string
  propertyName: string
  totalSf: number | null
  hasData: boolean
}) {
  return (
    <PdfDownloadButton
      label="⬇ Rent Roll"
      filename={`Wilkow-RentRoll-${sanitizeFilename(propertyName)}.pdf`}
      disabled={!hasData}
      title={hasData ? 'Download the latest rent roll as a branded PDF' : 'No rent roll loaded for this property'}
      build={async () => {
        const { data: snaps, error: sErr } = await supabase
          .from('rent_roll_snapshots')
          .select('id, period_year, period_month')
          .eq('property_id', propertyId)
          .order('period_year', { ascending: false })
          .order('period_month', { ascending: false })
          .limit(1)
        if (sErr) throw new Error(sErr.message)
        const snap = (snaps ?? [])[0] as { id: string; period_year: number; period_month: number } | undefined
        if (!snap) throw new Error('No rent roll snapshot for this property')

        const { data, error } = await supabase
          .from('rent_roll_rows')
          .select('suite, tenant_name, sqft, lease_start, lease_end, monthly_base_rent, annual_base_rent, base_rent_psf, is_occupied')
          .eq('snapshot_id', snap.id)
          .limit(1000)
        if (error) throw new Error(error.message)

        const rows = ((data ?? []) as any[]).map(r => ({
          suite: r.suite,
          tenantName: r.tenant_name,
          sqft: Number(r.sqft ?? 0),
          leaseStart: r.lease_start,
          leaseEnd: r.lease_end,
          monthlyRent: Number(r.monthly_base_rent ?? 0),
          annualRent: Number(r.annual_base_rent ?? 0),
          psf: Number(r.base_rent_psf ?? 0),
          isOccupied: !!r.is_occupied,
        }))

        const walt = computeWALT(
          rows.filter(r => r.isOccupied && r.leaseEnd).map(r => ({ leasedSf: r.sqft, expirationDate: r.leaseEnd as string })),
          new Date(),
        )

        const { buildRentRollPdf } = await import('./RentRollReport')
        return buildRentRollPdf({
          propertyName,
          totalSf,
          asOfLabel: `${MONTH[snap.period_month]} ${snap.period_year}`,
          rows,
          walt,
          generatedAt: new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }),
        })
      }}
    />
  )
}
