import { useState } from 'react'
import { fetchDocAbstracts, generateDocAbstract } from '../hooks/useDocAbstracts'

const WILKOW = '#466371'

export interface AbstractDocRef {
  documentId: string
  propertyId: string | null
  title: string
  docType?: string | null
  roleLabel?: string | null
  context?: unknown
}

// Generates (on demand, cached) narrative abstracts for a set of documents, then
// compiles them into one branded per-property PDF. Reused by the Transactions
// and Management pages. Generation is capped at a small concurrency so a large
// property doesn't fire a burst of Claude calls at once.
async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      await fn(items[idx])
    }
  })
  await Promise.all(workers)
}

export function DocAbstractsButton({
  kind, docs, reportTitle, reportSubtitle, scopeLabel, fileName, disabled, disabledReason,
}: {
  kind: 'transaction' | 'management'
  docs: AbstractDocRef[]
  reportTitle: string
  reportSubtitle: string
  scopeLabel: string
  fileName: string
  disabled?: boolean
  disabledReason?: string
}) {
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const off = disabled || docs.length === 0 || state === 'working'

  async function run() {
    if (off) return
    setState('working'); setMsg(null); setProgress(null)
    try {
      const ids = docs.map(d => d.documentId)
      const cached = await fetchDocAbstracts(ids)
      const abstracts = new Map<string, any>()
      for (const [id, row] of cached) if (row.abstract) abstracts.set(id, row.abstract)

      const missing = docs.filter(d => !abstracts.has(d.documentId))
      let failed = 0
      if (missing.length) {
        let done = 0
        setProgress({ done: 0, total: missing.length })
        await pool(missing, 3, async (d) => {
          try {
            const ab = await generateDocAbstract({ documentId: d.documentId, kind, propertyId: d.propertyId, context: d.context })
            if (ab) abstracts.set(d.documentId, ab)
            else failed++
          } catch {
            failed++
          } finally {
            done++
            setProgress({ done, total: missing.length })
          }
        })
      }

      const items = docs
        .filter(d => abstracts.has(d.documentId))
        .map(d => ({ docTitle: d.title, docType: d.docType ?? null, roleLabel: d.roleLabel ?? null, abstract: abstracts.get(d.documentId) }))

      if (items.length === 0) {
        setState('error'); setMsg('No abstracts could be generated (no readable text/PDF for these documents).')
        return
      }

      const { buildDocAbstractsPdf } = await import('../reports/DocAbstractsReport')
      const blob = await buildDocAbstractsPdf({
        title: reportTitle,
        subtitle: reportSubtitle,
        scopeLabel,
        generatedAt: new Date().toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' }),
        items,
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = fileName
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)

      setState('idle'); setProgress(null)
      setMsg(failed > 0 ? `${items.length} abstracted · ${failed} could not be read` : null)
    } catch (e: any) {
      setState('error'); setProgress(null)
      setMsg(e?.message ?? 'Failed to build abstracts')
    }
  }

  const label = state === 'working'
    ? (progress ? `Abstracting ${progress.done}/${progress.total}…` : 'Preparing…')
    : state === 'error' ? 'Failed — retry'
    : '⬇ Abstracts PDF'

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        onClick={run}
        disabled={off}
        title={off && disabledReason ? disabledReason : (docs.length ? `Generate & download narrative abstracts for ${docs.length} active document${docs.length === 1 ? '' : 's'}` : 'No active documents to abstract')}
        style={{
          fontSize: 11.5, fontWeight: 600, padding: '8px 16px', borderRadius: 8, whiteSpace: 'nowrap',
          border: `1px solid ${state === 'error' ? '#c25b52' : WILKOW}`,
          background: state === 'error' ? 'transparent' : WILKOW,
          color: state === 'error' ? '#c25b52' : '#f2f3f5',
          cursor: off ? 'default' : 'pointer',
          opacity: (disabled || docs.length === 0) && state !== 'working' ? 0.5 : 1,
        }}
      >
        {label}
      </button>
      {msg && <span style={{ fontSize: 11, color: state === 'error' ? '#c25b52' : 'var(--text-faint)' }}>{msg}</span>}
    </span>
  )
}
