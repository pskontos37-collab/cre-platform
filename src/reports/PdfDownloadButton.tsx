import { useState } from 'react'

const WILKOW = '#466371'

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
  const [state, setState] = useState<'idle' | 'busy' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const off = !!disabled || state === 'busy'

  async function onClick() {
    if (off) return
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
      setError(msg)
      setState('error')
    }
  }

  return (
    <button
      onClick={onClick}
      disabled={off}
      title={state === 'error' && error ? `Error: ${error}` : title}
      style={{
        fontSize: 11.5, fontWeight: 600, padding: '8px 16px', borderRadius: 8, whiteSpace: 'nowrap',
        border: `1px solid ${state === 'error' ? '#c25b52' : WILKOW}`,
        background: state === 'error' ? 'transparent' : WILKOW,
        color: state === 'error' ? '#c25b52' : '#f2f3f5',
        cursor: off ? 'default' : 'pointer',
        opacity: disabled && state !== 'busy' ? 0.5 : 1,
      }}
    >
      {state === 'busy' ? (busyLabel ?? 'Generating PDF…') : state === 'error' ? 'Failed — retry' : label}
    </button>
  )
}

export const sanitizeFilename = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
