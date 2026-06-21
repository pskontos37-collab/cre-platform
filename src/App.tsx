import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { ThemeProvider } from './contexts/ThemeContext'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { FilterProvider } from './contexts/FilterContext'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
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

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <DashboardPage />
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
