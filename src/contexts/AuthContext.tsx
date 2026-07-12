import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import type { User, Session } from '@supabase/supabase-js'
import { supabase, isSupabaseConfigured } from '../lib/supabase'
import type { User as AppUser } from '../types/database'

interface AuthState {
  user: User | null
  appUser: AppUser | null
  session: Session | null
  loading: boolean
}

interface AuthContextType extends AuthState {
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  updatePassword: (newPassword: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextType | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    appUser: null,
    session: null,
    loading: true,
  })

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setState(s => ({ ...s, loading: false }))
      return
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      setState(s => ({ ...s, session, user: session?.user ?? null }))
      if (session?.user) {
        fetchAppUser(session.user.id)
      } else {
        setState(s => ({ ...s, loading: false }))
      }
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setState(s => ({ ...s, session, user: session?.user ?? null }))
      if (session?.user) {
        fetchAppUser(session.user.id)
      } else {
        setState(s => ({ ...s, appUser: null, loading: false }))
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function fetchAppUser(userId: string) {
    const { data } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single()
    setState(s => ({ ...s, appUser: data as AppUser | null, loading: false }))
  }

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error?.message ?? null }
  }

  // Self-service password change for the logged-in user. Supabase's updateUser
  // re-issues the session, so no re-login is needed after a successful change.
  async function updatePassword(newPassword: string) {
    const { error } = await supabase.auth.updateUser({ password: newPassword })
    return { error: error?.message ?? null }
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ ...state, signIn, updatePassword, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
