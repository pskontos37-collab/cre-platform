// Service-agreement generator — editable Word (.docx) renderer.
//
// Renders the canonical content model (content.ts) to a .docx Blob using the
// `docx` library. This is the internal / signature copy: staff can still open
// it in Word and tweak or wet-sign exactly like the file-room template. The
// wording is transcribed verbatim from the approved template; only the layout
// (Word's exact tab stops) is regenerated.
//
// Dynamic-imported by the builder page so `docx` stays out of the main bundle.

import {
  AlignmentType, BorderStyle, Document, Packer, Paragraph, Table, TableCell,
  TableRow, TextRun, WidthType,
} from 'docx'
import { buildContent, type Block, type Run, type SignatureData } from './content'
import type { AgreementInput } from './config'

const FONT = 'Arial'
const SIZE = 20          // half-points => 10pt body
const TITLE_SIZE = 24    // 12pt

const runs = (rs: Run[], size = SIZE) =>
  rs.map(r => new TextRun({ text: r.t, bold: r.b, font: FONT, size }))

const alignOf = (a?: Block['align']) =>
  a === 'center' ? AlignmentType.CENTER : a === 'left' ? AlignmentType.LEFT : AlignmentType.JUSTIFIED

function blockToParagraph(bk: Block): Paragraph {
  if (bk.kind === 'title') {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 120, after: 200 },
      children: runs(bk.runs, TITLE_SIZE),
    })
  }
  if (bk.kind === 'heading') {
    return new Paragraph({
      alignment: alignOf(bk.align),
      spacing: { before: 120, after: 120 },
      children: runs(bk.runs),
    })
  }
  const left = (bk.indent ?? 0) * 360   // twips; 360 = 0.25"
  return new Paragraph({
    alignment: alignOf(bk.align),
    spacing: { after: 120 },
    indent: left ? { left } : undefined,
    children: runs(bk.runs),
  })
}

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } as const
const CELL_BORDERS = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER }

function line(text: string, bold = false) {
  return new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text, bold, font: FONT, size: SIZE })] })
}

function signatureTable(sig: SignatureData): Table {
  const ownerCol: Paragraph[] = [
    line('OWNER:', true),
    line(sig.ownerEntity, true),
    ...sig.ownerChain.map(c => line(c)),
    line(''),
    line('By: _______________________________'),
    line(`Name: ${sig.ownerName || '_____________________________'}`),
    line(`Title: ${sig.ownerTitle || '______________________________'}`),
  ]
  const vendorCol: Paragraph[] = [
    line('VENDOR:', true),
    line(sig.vendorName || '_______________________________', true),
    line(''), line(''), line(''),
    line('By: _______________________________'),
    line(`Name: ${sig.vendorSignName || '_____________________________'}`),
    line(`Title: ${sig.vendorSignTitle || '______________________________'}`),
  ]
  const cell = (children: Paragraph[]) =>
    new TableCell({ children, borders: CELL_BORDERS, width: { size: 50, type: WidthType.PERCENTAGE } })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER,
      insideHorizontal: NO_BORDER, insideVertical: NO_BORDER,
    },
    rows: [new TableRow({ children: [cell(ownerCol), cell(vendorCol)] })],
  })
}

export async function buildAgreementDocx(input: AgreementInput): Promise<Blob> {
  const { agreement, signature, exhibitB } = buildContent(input)

  const body: (Paragraph | Table)[] = [
    ...agreement.map(blockToParagraph),
    signatureTable(signature),
    // Page break before Exhibit B
    new Paragraph({ pageBreakBefore: true, children: [] }),
    ...exhibitB.map(blockToParagraph),
  ]

  const doc = new Document({
    creator: 'M&J Wilkow Asset Management Platform',
    title: 'Service Agreement',
    styles: {
      default: {
        document: { run: { font: FONT, size: SIZE } },
      },
    },
    sections: [{
      properties: { page: { margin: { top: 1080, bottom: 1080, left: 1440, right: 1440 } } },
      children: body,
    }],
  })

  return Packer.toBlob(doc)
}
