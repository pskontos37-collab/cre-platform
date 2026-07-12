// pdfRender.ts — render a site-plan PDF page to a <canvas> for the interactive
// site-plan map. We lazy-load the SAME bundled pdf.js the document viewer ships
// (public/pdfjs/build), so there is no extra npm dependency and nothing extra to
// bundle. The dynamic import is @vite-ignore'd, so the browser fetches
// pdf.mjs from public/ at runtime in both dev and production.

let pdfjsPromise: Promise<any> | null = null

// The specifier MUST stay non-static so the bundler can't resolve or bundle it:
// Rollup/esbuild constant-fold tricks like `[...].join('/')` back into the literal
// `/pdfjs/build/pdf.mjs`, then fail the build because a `/`-rooted path has no
// on-disk module. Prefixing with the runtime origin defeats folding entirely, and
// the browser fetches the static asset from public/. (window is always present —
// this is a client-only SPA.)
const PDFJS_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''
const PDFJS_SRC    = PDFJS_ORIGIN + '/pdfjs/build/pdf.mjs'
const PDFJS_WORKER = PDFJS_ORIGIN + '/pdfjs/build/pdf.worker.mjs'

async function loadPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = import(/* @vite-ignore */ PDFJS_SRC).then((lib: any) => {
      try { lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER } catch { /* fake worker fallback */ }
      return lib
    })
  }
  return pdfjsPromise
}

export interface LoadedPdf {
  numPages: number
  // Render one page into `canvas`, scaled so its width ≈ targetWidth (CSS px).
  // Returns the pixel size the canvas was set to. When timeoutMs > 0 the render
  // is bounded and the underlying pdf.js RenderTask is CANCELLED on timeout (so
  // it stops consuming the renderer) before rejecting — essential when rendering
  // many heavy sheets in a row, or one runaway sheet starves all the rest.
  renderPage: (pageNum: number, canvas: HTMLCanvasElement, targetWidth: number, timeoutMs?: number) => Promise<{ width: number; height: number }>
  destroy: () => void
}

export async function openPdf(url: string): Promise<LoadedPdf> {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({ url }).promise
  return {
    numPages: doc.numPages,
    async renderPage(pageNum: number, canvas: HTMLCanvasElement, targetWidth: number, timeoutMs = 0) {
      const page = await doc.getPage(Math.min(Math.max(1, pageNum), doc.numPages))
      const base = page.getViewport({ scale: 1 })
      // Cap the render scale so a huge architectural sheet doesn't blow up memory.
      const scale = Math.min(targetWidth > 0 ? targetWidth / base.width : 1, 4)
      const viewport = page.getViewport({ scale })
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2D canvas context unavailable')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      const task = page.render({ canvasContext: ctx, viewport })
      if (timeoutMs > 0) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const guard = new Promise<never>((_, rej) => {
          timer = setTimeout(() => { try { task.cancel() } catch { /* ignore */ } rej(new Error('render timeout')) }, timeoutMs)
        })
        try { await Promise.race([task.promise, guard]) } finally { clearTimeout(timer) }
      } else {
        await task.promise
      }
      return { width: canvas.width, height: canvas.height }
    },
    destroy() { try { doc.destroy() } catch { /* ignore */ } },
  }
}
