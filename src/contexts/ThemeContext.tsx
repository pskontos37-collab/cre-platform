import { createContext, useContext, useEffect, useState, ReactNode } from 'react'

export type ThemeId = 'dark-pro' | 'light' | 'ocean' | 'midnight'

export interface ThemeOption {
  id: ThemeId
  name: string
  preview: string
  textPreview: string
}

export const THEMES: ThemeOption[] = [
  { id: 'dark-pro',  name: 'Dark Pro',   preview: '#030712', textPreview: '#f9fafb' },
  { id: 'light',     name: 'Light',      preview: '#f8fafc', textPreview: '#0f172a' },
  { id: 'ocean',     name: 'Ocean',      preview: '#040d18', textPreview: '#e0f2fe' },
  { id: 'midnight',  name: 'Midnight',   preview: '#0a0a14', textPreview: '#e8e8ff' },
]

interface ThemeContextType {
  theme: ThemeId
  setTheme: (id: ThemeId) => void
}

const ThemeContext = createContext<ThemeContextType | null>(null)

const STORAGE_KEY = 'cre-theme'

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeId | null
    return saved && THEMES.some(t => t.id === saved) ? saved : 'dark-pro'
  })

  useEffect(() => {
    if (theme === 'dark-pro') {
      document.documentElement.removeAttribute('data-theme')
    } else {
      document.documentElement.setAttribute('data-theme', theme)
    }
  }, [theme])

  function setTheme(id: ThemeId) {
    setThemeState(id)
    localStorage.setItem(STORAGE_KEY, id)
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
