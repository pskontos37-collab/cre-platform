import { PdfDownloadButton } from './PdfDownloadButton'

// Per-agreement "Abstract PDF" trigger for REAs (/rea) and JV operating
// agreements (/waterfall). Dynamic-imports the report so @react-pdf stays out
// of the main bundle. Disabled until the agreement has a generated abstract.

export function AgreementAbstractPdfButton({ kind, name, abstract, qa, qaStatus, qaAt }: {
  kind: 'rea' | 'jv' | 'pma'
  name: string
  abstract: any
  qa?: any | null
  qaStatus?: string | null
  qaAt?: string | null
}) {
  return (
    <PdfDownloadButton
      label="⬇ Abstract PDF"
      busyLabel="Generating PDF…"
      filename={`Wilkow-Abstract-${name.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 80)}.pdf`}
      disabled={!abstract}
      title={abstract ? 'Download the verified abstract as a branded PDF' : 'No generated abstract for this agreement yet'}
      build={async () => {
        const { buildAgreementAbstractPdf } = await import('./AgreementAbstractReport')
        return buildAgreementAbstractPdf({
          kind, name, abstract, qa, qaStatus, qaAt,
          generatedAt: new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }),
        })
      }}
    />
  )
}
