import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { FilterProvider } from './contexts/FilterContext'
import LoginPage from './pages/LoginPage'
import ResetPasswordPage from './pages/ResetPasswordPage'
import DashboardPage from './pages/DashboardPage'
import { DocumentsPage } from './pages/DocumentsPage'
import { FormsPage } from './pages/FormsPage'
import { EmergencyManualsPage } from './pages/EmergencyManualsPage'
import { InspectionsPage } from './pages/InspectionsPage'
import { InspectFieldPage } from './pages/InspectFieldPage'
import { ContactsPage } from './pages/ContactsPage'
import { FinancialsPage } from './pages/FinancialsPage'
import { WaterfallPage } from './pages/WaterfallPage'
import { ManagementPage } from './pages/ManagementPage'
import { PropertiesPage } from './pages/PropertiesPage'
import { PropertyDetailPage } from './pages/PropertyDetailPage'
import { SitePlansPage } from './pages/SitePlansPage'
import { AskPage } from './pages/AskPage'
import { AbstractsPage } from './pages/AbstractsPage'
import { ClausesPage } from './pages/ClausesPage'
import { DiligencePage } from './pages/DiligencePage'
import { MriReconPage } from './pages/MriReconPage'
import { MarketReportsPage } from './pages/MarketReportsPage'
import { ReceivablesPage } from './pages/ReceivablesPage'
import { TasksPage } from './pages/TasksPage'
import { ReaPage } from './pages/ReaPage'
import { ServiceAgreementsPage } from './pages/ServiceAgreementsPage'
import { ServiceAgreementBuilderPage } from './pages/ServiceAgreementBuilderPage'
import { BrokeragePage } from './pages/BrokeragePage'
import { TransactionsPage } from './pages/TransactionsPage'
import { PipelinePage } from './pages/PipelinePage'
import { AdminPage } from './pages/AdminPage'
import { AppLayout } from './components/layout/AppLayout'
import { canSeePage } from './lib/pages'
import { ReactNode } from 'react'

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div
        style={{
          minHeight:      '100vh',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          background:     'var(--bg)',
          color:          'var(--text-faint)',
          fontSize:       13,
        }}
      >
        Loading…
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

// Blocks direct-URL access to a page the user's role/template hides. The nav
// already omits it; this stops someone typing the path. Redirects to Dashboard.
function RequirePage({ pageKey, children }: { pageKey: string; children: ReactNode }) {
  const { appUser, loading } = useAuth()
  if (loading) return null
  if (!canSeePage(appUser, pageKey)) return <Navigate to="/" replace />
  return <>{children}</>
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* Public: reached via the password-reset email link (recovery token in URL). */}
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      {/* /import removed 2026-07-03 — Drive pipeline retired; bulk-import there
          could double-count Knightdale via the Consolidated entity. */}
      <Route
        path="/tasks"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="tasks">
              <AppLayout>
                <TasksPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/pipeline"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="pipeline">
              <AppLayout>
                <PipelinePage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/ask"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="ask">
              <AppLayout>
                <AskPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/properties"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="properties">
              <AppLayout>
                <PropertiesPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/properties/:id"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="properties">
              <AppLayout>
                <PropertyDetailPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/siteplans"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="siteplans">
              <AppLayout>
                <SitePlansPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/financials"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="financials">
              <AppLayout>
                <FinancialsPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/receivables"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="receivables">
              <AppLayout>
                <ReceivablesPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/rea"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="rea">
              <AppLayout>
                <ReaPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/services"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="services">
              <AppLayout>
                <ServiceAgreementsPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/services/new"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="svc_new">
              <AppLayout>
                <ServiceAgreementBuilderPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/brokerage"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="brokerage">
              <AppLayout>
                <BrokeragePage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/transactions"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="transactions">
              <AppLayout>
                <TransactionsPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/waterfall"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="waterfall">
              <AppLayout>
                <WaterfallPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/management"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="management">
              <AppLayout>
                <ManagementPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/documents"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="documents">
              <AppLayout>
                <DocumentsPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/forms"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="forms">
              <AppLayout>
                <FormsPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/emergency-manuals"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="emergency">
              <AppLayout>
                <EmergencyManualsPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/contacts"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="contacts">
              <AppLayout>
                <ContactsPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/inspections"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="inspections">
              <AppLayout>
                <InspectionsPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      {/* Standalone, chrome-less field entry point — same auth/data, no AppLayout. */}
      <Route
        path="/inspect"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="inspections">
              <InspectFieldPage />
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/abstracts"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="abstracts">
              <AppLayout>
                <AbstractsPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/clauses"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="clauses">
              <AppLayout>
                <ClausesPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/diligence"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="diligence">
              <AppLayout>
                <DiligencePage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/mri-recon"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="mri">
              <AppLayout>
                <MriReconPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/market"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="market">
              <AppLayout>
                <MarketReportsPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <RequirePage pageKey="admin">
              <AppLayout>
                <AdminPage />
              </AppLayout>
            </RequirePage>
          </ProtectedRoute>
        }
      />
      <Route
        path="*"
        element={
          <ProtectedRoute>
            <Navigate to="/" replace />
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <FilterProvider>
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </FilterProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}
