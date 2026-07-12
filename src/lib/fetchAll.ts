// PostgREST caps every response at the project's db-max-rows (1,000) even when
// the client asks for more, silently truncating. These helpers page through
// .range() windows until a short page signals the end of the set.
//
// IMPORTANT: the query being paged MUST have a fully deterministic ORDER BY
// (unique tiebreaker) — otherwise rows can duplicate or vanish across pages.

const PAGE = 1000

type PageResult<T> = { data: T[] | null; error: { message: string } | null }

export async function fetchAllRows<T>(
  buildPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  maxRows = 50000,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; from < maxRows; from += PAGE) {
    const { data, error } = await buildPage(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}
