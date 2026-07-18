import { ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { AbstractJobsToaster } from '../abstracts/AbstractJobsToaster'

interface AppLayoutProps {
  children: ReactNode
}

export function AppLayout({ children }: AppLayoutProps) {
  return (
    <div className="app-shell" style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg)' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Header />
        <main className="app-main" style={{ flex: 1, padding: '20px 24px', overflowY: 'auto', minWidth: 0 }}>
          {children}
        </main>
      </div>
      {/* App-wide notifier for abstract upload / re-abstract background jobs. */}
      <AbstractJobsToaster />
    </div>
  )
}
