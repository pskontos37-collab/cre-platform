import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'

// A deploy replaces the hashed chunk files, so a tab opened before the deploy
// fails its next dynamic import (every PDF/Excel export button dynamic-imports
// its report module). Vite surfaces those failures as a cancelable
// vite:preloadError — reload once to pick up the new bundle instead of
// stranding every export button behind "Failed — retry". The timestamp guard
// keeps a genuinely broken network from looping reloads.
window.addEventListener('vite:preloadError', event => {
  const KEY = 'cre-chunk-reload-at'
  const last = Number(sessionStorage.getItem(KEY) ?? 0)
  if (Date.now() - last < 60_000) return // just reloaded and still failing — surface the error
  sessionStorage.setItem(KEY, String(Date.now()))
  event.preventDefault()
  window.location.reload()
})

// The inner boundary in AppLayout keeps the shell alive for a page-level throw.
// This outer one is the last resort: if the layout, router or a provider throws,
// there is no shell left to preserve, and without it the user gets a white page.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="root">
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
