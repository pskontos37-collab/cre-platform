import type { ArAgingRow } from '../hooks/useArAging'
import { PdfDownloadButton } from './PdfDownloadButton'

// Generates the branded A/R Aging PDF client-side and triggers a download.
export function ArAgingPdfButton({ rows, notes, reaMris, asOf }: {
  rows: ArAgingRow[]
  notes: Record<string, string>
  reaMris: Set<string>
  asOf: string | null
}) {
  return (
    <PdfDownloadButton
      label="⬇ PDF Report"
      filename={`Wilkow-AR-Aging-${asOf ?? 'latest'}.pdf`}
      disabled={rows.length === 0}
      title={rows.length === 0 ? 'No A/R data loaded' : 'Download a branded PDF of this A/R aging snapshot'}
      build={async () => {
        const { buildArAgingPdf } = await import('./ArAgingReport')
        return buildArAgingPdf({
          rows,
          notes,
          reaMris: Array.from(reaMris),
          asOf,
          generatedAt: new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }),
        })
      }}
    />
  )
}
