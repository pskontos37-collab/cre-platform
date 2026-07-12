import type { CSSProperties } from 'react'
import { useQuery } from '../hooks/useQuery'
import { supabase } from '../lib/supabase'
import { Widget, WidgetSkeleton } from '../components/ui/Widget'
import { EmptyState } from '../components/ui/EmptyState'

// Firm-wide reference forms & templates (form_templates table, storage keys
// under forms/ in the documents bucket). Read-only library: PMs grab the
// current inspection scorecards here; the future inspection app will submit
// completed reports back into the system via email ingest.

interface FormRow {
  id: string
  category: string
  title: string
  description: string | null
  version_label: string | null
  file_name: string
  file_path: string
  pdf_path: string | null
  updated_at: string
  pdfUrl: string | null
  downloadUrl: string | null
}

const CATEGORY_LABEL: Record<string, string> = {
  inspection: 'Property Inspections',
  emergency: 'Emergency Procedures',
}

// Label the download button by the source file type (Word / Excel / generic).
function downloadLabel(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (ext === 'doc' || ext === 'docx') return 'Download Word'
  if (ext === 'xls' || ext === 'xlsx' || ext === 'xlsm') return 'Download Excel'
  return 'Download'
}

function useFormTemplates() {
  return useQuery<FormRow[]>(async () => {
    const { data, error } = await supabase
      .from('form_templates')
      .select('id, category, title, description, version_label, file_name, file_path, pdf_path, updated_at')
      .eq('is_active', true)
      .order('category')
      .order('sort_order')
      .order('title')
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as Omit<FormRow, 'pdfUrl' | 'downloadUrl'>[]

    const paths = [...new Set(rows.flatMap(r => [r.file_path, r.pdf_path]).filter((p): p is string => !!p))]
    const signed = new Map<string, string>()
    if (paths.length) {
      const { data: s } = await supabase.storage.from('documents').createSignedUrls(paths, 3600)
      for (const it of s ?? []) if (it.path && it.signedUrl) signed.set(it.path, it.signedUrl)
    }

    return rows.map(r => ({
      ...r,
      pdfUrl: r.pdf_path ? signed.get(r.pdf_path) ?? null : null,
      // &download= (empty) makes storage serve it as an attachment with the object's filename
      downloadUrl: signed.has(r.file_path) ? `${signed.get(r.file_path)}&download=${encodeURIComponent(r.file_name)}` : null,
    }))
  }, [])
}

const btnStyle = (primary: boolean): CSSProperties => ({
  fontSize: 12, fontWeight: 600, padding: '6px 14px', borderRadius: 6, textDecoration: 'none',
  border: primary ? 'none' : '1px solid var(--border-2)',
  background: primary ? 'var(--accent)' : 'var(--surface-2)',
  color: primary ? '#fff' : 'var(--text)', whiteSpace: 'nowrap',
})

export function FormsPage() {
  const forms = useFormTemplates()
  const rows = forms.data ?? []

  const categories = [...new Set(rows.map(r => r.category))]

  return (
    <div style={{ padding: '24px 32px', maxWidth: 900 }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Forms &amp; Templates</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18 }}>
        Current firm forms for property and asset managers — always the latest version. View the PDF
        in the browser or download the original file to fill out.
      </div>

      {forms.loading && <Widget title="Forms"><WidgetSkeleton rows={4} /></Widget>}
      {forms.error && <div style={{ fontSize: 12, color: 'var(--red)' }}>{forms.error}</div>}

      {!forms.loading && !forms.error && rows.length === 0 && (
        <Widget title="Forms">
          <EmptyState icon="📋" title="No forms published yet"
            subtitle="Firm reference forms will appear here as they are added" />
        </Widget>
      )}

      {categories.map(cat => (
        <div key={cat} style={{ marginBottom: 24 }}>
          <div style={{
            fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: 'uppercase',
            color: 'var(--text-faint)', marginBottom: 10,
          }}>
            {CATEGORY_LABEL[cat] ?? cat}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {rows.filter(r => r.category === cat).map(r => (
              <div key={r.id} style={{
                padding: '14px 16px', borderRadius: 8, border: '1px solid var(--border)',
                background: 'var(--surface)', display: 'flex', gap: 16, alignItems: 'center',
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>{r.title}</span>
                    {r.version_label && (
                      <span style={{
                        fontSize: 10, color: 'var(--text-faint)', border: '1px solid var(--border-2)',
                        borderRadius: 10, padding: '1px 8px', whiteSpace: 'nowrap',
                      }}>
                        {r.version_label}
                      </span>
                    )}
                  </div>
                  {r.description && (
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>{r.description}</div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>
                    {r.file_name} · updated {new Date(r.updated_at).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {r.pdfUrl && (
                    <a href={r.pdfUrl} target="_blank" rel="noopener noreferrer" style={btnStyle(true)}>View PDF</a>
                  )}
                  {r.downloadUrl && (
                    <a href={r.downloadUrl} style={btnStyle(false)}>{downloadLabel(r.file_name)}</a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
