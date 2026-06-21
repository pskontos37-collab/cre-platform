import { useState, useEffect, useCallback, useRef } from 'react'

export interface QueryResult<T> {
  data: T | null
  loading: boolean
  error: string | null
  refetch: () => void
}

export function useQuery<T>(
  fetcher: () => Promise<T>,
  deps: unknown[] = [],
): QueryResult<T> {
  const [data, setData]       = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const fetcherRef            = useRef(fetcher)
  fetcherRef.current          = fetcher

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await fetcherRef.current()
      setData(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      setData(null)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => { run() }, [run])

  return { data, loading, error, refetch: run }
}
