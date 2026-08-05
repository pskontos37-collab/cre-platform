import { useState } from 'react'

const WILKOW = '#466371'

// A dynamic import that fails because the deployment changed under an open tab
// (old hashed chunk gone). The vite:preloadError handler in main.tsx reloads
// once automatically; this classifies the stragglers so the button can say
// "refresh" instead of a dead-end "Failed".
export function staleChunkMessage(err: unknown): string | null {
  const msg = err instanceof Error ? err.message : String(err)
  return /dynamically imported module|Importing a module script failed|error loading chunk|ChunkLoadError|Failed to fetch dynamically/i.test(msg)
    ? 'The app was updated since this page loaded — refresh the page and try again.'
    : null
}

// Shared PDF-download button: runs `build` (which should dynamic-import its
// report module so @react-pdf/renderer stays out of the main bundle), then
// downloads the returned blob under `filename`.
export function PdfDownloadButton({ label, filename, build, disabled, title, busyLabel }: {
  label: string
  filename: string
  build: () => Promise<Blob>
  disabled?: boolean
  title?: string
  busyLabel?: string        // e.g. 'Generating PPT…' — defaults to the PDF wording
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'error' | 'stale'>('idle')
  const [error, setError] = useState<string | null>(null)
  const off = !!disabled || state === 'busy'

  async function onClick() {
    if (off) return
    if (state === 'stale') { window.location.reload(); return }
    setState('busy')
    setError(null)
    try {
      const blob = await build()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setState('idle')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[report-generation]', msg)
      const stale = staleChunkMessage(err)
      setError(stale ?? msg)
      setState(stale ? 'stale' : 'error')
    }
  }

  const failed = state === 'error' || state === 'stale'
  return (
    <button
      onClick={onClick}
      disabled={off}
      title={failed && error ? `Error: ${error}` : title}
      style={{
        fontSize: 11.5, fontWeight: 600, padding: '8px 16px', borderRadius: 8, whiteSpace: 'nowrap',
        border: `1px solid ${failed ? '#c25b52' : WILKOW}`,
        background: failed ? 'transparent' : WILKOW,
        color: failed ? '#c25b52' : '#f2f3f5',
        cursor: off ? 'default' : 'pointer',
        opacity: disabled && state !== 'busy' ? 0.5 : 1,
      }}
    >
      {state === 'busy' ? (busyLabel ?? 'Generating PDF…')
        : state === 'stale' ? 'App updated — click to refresh'
        : state === 'error' ? 'Failed — retry' : label}
    </button>
  )
}

export const sanitizeFilename = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
