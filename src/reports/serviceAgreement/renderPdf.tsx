// Service-agreement generator — send-ready PDF renderer + package assembly.
//
// Renders the canonical content model (content.ts) to a clean legal-style PDF
// (portrait letter, Helvetica, no marketing chrome), then uses pdf-lib to
// assemble the full package in signing order:
//
//   Agreement (+ signature block)  ->  Exhibit A (vendor's uploaded proposal)
//                                  ->  Exhibit B (insurance requirements)
//
// This is the copy emailed to the vendor for signature. Dynamic-imported so
// @react-pdf/renderer + pdf-lib stay out of the main bundle.

import type { ReactElement } from 'react'
import { Document, Page, Text, View, pdf } from '@react-pdf/renderer'
import { PDFDocument } from 'pdf-lib'
import { buildContent, type Block, type SignatureData } from './content'
import { pdfSafe } from '../theme'
import type { AgreementInput } from './config'

const RULE = '#c9d1d6'
const TEXT = '#111417'

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((bk, i) => {
        const children = bk.runs.map((r, j) => (
          <Text key={j} style={{ fontFamily: r.b ? 'Helvetica-Bold' : 'Helvetica' }}>{pdfSafe(r.t)}</Text>
        ))
        if (bk.kind === 'title') {
          return <Text key={i} style={{ textAlign: 'center', fontFamily: 'Helvetica-Bold', fontSize: 12, marginTop: 4, marginBottom: 10 }}>{children}</Text>
        }
        if (bk.kind === 'heading') {
          return <Text key={i} style={{ textAlign: bk.align === 'center' ? 'center' : 'left', fontFamily: 'Helvetica-Bold', marginTop: 6, marginBottom: 6 }}>{children}</Text>
        }
        const align = bk.align === 'left' ? 'left' : bk.align === 'center' ? 'center' : 'justify'
        return (
          <Text key={i} style={{ textAlign: align as any, marginLeft: (bk.indent ?? 0) * 16, marginBottom: 6, lineHeight: 1.35 }}>
            {children}
          </Text>
        )
      })}
    </>
  )
}

function SignatureBlock({ sig }: { sig: SignatureData }) {
  const Col = ({ lines }: { lines: { t: string; b?: boolean }[] }) => (
    <View style={{ width: '50%', paddingRight: 12 }}>
      {lines.map((l, i) => (
        <Text key={i} style={{ fontFamily: l.b ? 'Helvetica-Bold' : 'Helvetica', marginBottom: 3 }}>{pdfSafe(l.t)}</Text>
      ))}
    </View>
  )
  const owner = [
    { t: 'OWNER:', b: true },
    { t: sig.ownerEntity, b: true },
    ...sig.ownerChain.map(c => ({ t: c })),
    { t: ' ' },
    { t: 'By: _______________________________' },
    { t: `Name: ${sig.ownerName || '_____________________________'}` },
    { t: `Title: ${sig.ownerTitle || '______________________________'}` },
  ]
  const vendor = [
    { t: 'VENDOR:', b: true },
    { t: sig.vendorName || '_______________________________', b: true },
    { t: ' ' }, { t: ' ' }, { t: ' ' },
    { t: 'By: _______________________________' },
    { t: `Name: ${sig.vendorSignName || '_____________________________'}` },
    { t: `Title: ${sig.vendorSignTitle || '______________________________'}` },
  ]
  return (
    <View wrap={false} style={{ flexDirection: 'row', marginTop: 16 }}>
      <Col lines={owner} />
      <Col lines={vendor} />
    </View>
  )
}

function Footer({ label }: { label: string }) {
  return (
    <View fixed style={{ position: 'absolute', bottom: 24, left: 54, right: 54, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 0.75, borderTopColor: RULE, paddingTop: 5 }}>
      <Text style={{ fontSize: 7, color: '#8a949b' }}>{pdfSafe(label)}</Text>
      <Text style={{ fontSize: 7, color: '#8a949b' }} render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </View>
  )
}

function pageStyle() {
  return { paddingTop: 54, paddingBottom: 48, paddingHorizontal: 54, fontFamily: 'Helvetica', fontSize: 9.5, color: TEXT } as const
}

function AgreementPdf({ input }: { input: AgreementInput }) {
  const { agreement, signature } = buildContent(input)
  return (
    <Document title="Service Agreement" author="M&J Wilkow">
      <Page size="LETTER" style={pageStyle()}>
        <Blocks blocks={agreement} />
        <SignatureBlock sig={signature} />
        <Footer label="M&J Wilkow - Service Agreement" />
      </Page>
    </Document>
  )
}

function ExhibitBPdf({ input }: { input: AgreementInput }) {
  const { exhibitB } = buildContent(input)
  return (
    <Document title="Exhibit B - Insurance Requirements" author="M&J Wilkow">
      <Page size="LETTER" style={pageStyle()}>
        <Blocks blocks={exhibitB} />
        <Footer label="M&J Wilkow - Exhibit B" />
      </Page>
    </Document>
  )
}

async function toBytes(el: ReactElement): Promise<Uint8Array> {
  const blob = await pdf(el).toBlob()
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Full package PDF in signing order. `exhibitA` = the vendor's uploaded proposal
 * PDF bytes (optional). Throws a clear error if that file can't be read so a
 * legal exhibit is never silently dropped.
 */
export async function buildAgreementPdf(input: AgreementInput, exhibitA?: ArrayBuffer | Uint8Array): Promise<Blob> {
  const agreementBytes = await toBytes(<AgreementPdf input={input} />)
  const exhibitBBytes = await toBytes(<ExhibitBPdf input={input} />)

  const out = await PDFDocument.create()
  const append = async (bytes: ArrayBuffer | Uint8Array, what: string) => {
    let src: PDFDocument
    try {
      src = await PDFDocument.load(bytes, { ignoreEncryption: true })
    } catch (e) {
      throw new Error(`Could not read ${what} (it may be encrypted, image-only, or not a valid PDF).`)
    }
    const pages = await out.copyPages(src, src.getPageIndices())
    pages.forEach(p => out.addPage(p))
  }

  await append(agreementBytes, 'the generated agreement')
  if (exhibitA && (exhibitA as ArrayBuffer).byteLength !== 0) await append(exhibitA, 'the uploaded Exhibit A')
  await append(exhibitBBytes, 'Exhibit B')

  const bytes = await out.save()
  return new Blob([bytes], { type: 'application/pdf' })
}
