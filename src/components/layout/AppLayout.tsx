import { ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { AbstractJobsToaster } from '../abstracts/AbstractJobsToaster'
import { ErrorBoundary } from '../ErrorBoundary'

interface AppLayoutProps {
  children: ReactNode
}

export function AppLayout({ children }: AppLayoutProps) {
  const { pathname } = useLocation()
  return (
    <div className="app-shell" style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Header />
        <main className="app-main" style={{ flex: 1, padding: '20px 24px', overflowY: 'auto', minWidth: 0 }}>
          {/* KI-5: the boundary sits INSIDE the shell on purpose — a page that
              throws leaves the sidebar and header usable, so the user can
              navigate out instead of staring at a blank pane. Keying on the
              pathname clears the error on navigation. */}
          <ErrorBoundary resetKey={pathname} label={pathname}>
            {children}
          </ErrorBoundary>
        </main>
      </div>
      {/* App-wide notifier for abstract upload / re-abstract background jobs. */}
      <AbstractJobsToaster />
    </div>
  )
}
