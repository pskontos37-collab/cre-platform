// Small sessionStorage-backed cache for restoring the last search/answer when the
// user navigates away to another page and comes back. Survives route changes and
// page reloads within the session; cleared when the tab/browser closes.

export function loadCache<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null   // storage unavailable or corrupt JSON
  }
}

export function saveCache<T>(key: string, value: T): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota exceeded or storage unavailable — non-fatal, just don't persist */
  }
}
