import { useEffect, useState } from 'react'

// Small matchMedia hook so a component can render a phone layout without
// touching global CSS. `useMediaQuery('(max-width: 768px)')` → true on phones.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

export const useIsPhone = () => useMediaQuery('(max-width: 768px)')
