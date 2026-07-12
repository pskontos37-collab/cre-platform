import type { ReaAgreement } from '../hooks/useRea'
import { PdfDownloadButton } from './PdfDownloadButton'

export function ReaPdfButton({ agreements }: { agreements: ReaAgreement[] }) {
  return (
    <PdfDownloadButton
      label="⬇ PDF Report"
      filename="Wilkow-REA-Summary.pdf"
      disabled={agreements.length === 0}
      title={agreements.length === 0 ? 'No REAs in the current filter' : 'Download the REA summary as a branded PDF'}
      build={async () => {
        const { buildReaPdf } = await import('./ReaReport')
        return buildReaPdf({
          agreements,
          generatedAt: new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }),
        })
      }}
    />
  )
}
