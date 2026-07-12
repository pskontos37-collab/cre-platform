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
  // Returns the pixel size the canvas was set to.
  renderPage: (pageNum: number, canvas: HTMLCanvasElement, targetWidth: number) => Promise<{ width: number; height: number }>
  destroy: () => void
}

export async function openPdf(url: string): Promise<LoadedPdf> {
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({ url }).promise
  return {
    numPages: doc.numPages,
    async renderPage(pageNum: number, canvas: HTMLCanvasElement, targetWidth: number) {
      const page = await doc.getPage(Math.min(Math.max(1, pageNum), doc.numPages))
      const base = page.getViewport({ scale: 1 })
      // Cap the render scale so a huge architectural sheet doesn't blow up memory.
      const scale = Math.min(targetWidth > 0 ? targetWidth / base.width : 1, 4)
      const viewport = page.getViewport({ scale })
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('2D canvas context unavailable')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      await page.render({ canvasContext: ctx, viewport }).promise
      return { width: canvas.width, height: canvas.height }
    },
    destroy() { try { doc.destroy() } catch { /* ignore */ } },
  }
}
