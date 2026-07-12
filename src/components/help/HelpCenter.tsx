import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import {
  type HelpArticle, type HelpBlock, MEDIA_FOLDER_URL,
  getArticle, getSection, articlesInSection, searchArticles, suggestionsForPath,
} from '../../lib/helpContent'
import helpResources from '../../lib/helpResources.json'

// HelpCenter — the "?" button in the header plus the slide-over Help & Resources
// drawer. Two layers of content:
//   • Quick help — hand-written how-to articles (helpContent.ts)
//   • Resource library — the full M&J Wilkow document corpus (helpResources.json,
//     generated from K:\ by scripts/gen_help_library.ps1). Documents are served
//     via runtime signed URLs; recordings are cataloged with their location.

interface LibItem { title: string; kind: string; key?: string; pdf?: boolean; file?: string; loc?: string }
interface LibGroup { label: string; items: LibItem[] }
interface LibCollection { category: string; key: string; title: string; groups: LibGroup[] }
interface HelpLibrary { generated: string; categoryOrder: string[]; collections: LibCollection[] }

const LIB = helpResources as unknown as HelpLibrary
const CATEGORIES = LIB.categoryOrder.filter(c => LIB.collections.some(col => col.category === c))
const collectionsIn = (cat: string) => LIB.collections.filter(c => c.category === cat)
const getCollection = (key: string) => LIB.collections.find(c => c.key === key)

// curated quick-help sections to surface on the home screen (prose how-tos)
const QUICK_HELP = ['how-do-i', 'insurance-ebix', 'contacts', 'glossary']

const CAT_ICON: Record<string, string> = {
  'Policy Manual': 'M4 4h11l5 5v11H4z',
  'M&J University': 'M12 3L2 8l10 5 10-5-10-5z M6 10v5c0 1 3 3 6 3s6-2 6-3v-5',
  'Forms & Templates': 'M9 2h6l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z',
  'Emergency & Life Safety': 'M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z',
  'Departments': 'M3 21h18M6 21V9l6-4 6 4v12',
}
const catCount = (cat: string) =>
  collectionsIn(cat).reduce((n, c) => n + c.groups.reduce((m, g) => m + g.items.length, 0), 0)

interface LibHit { title: string; key?: string; pdf?: boolean; file?: string; ctx: string }
function libSearch(q: string): LibHit[] {
  const t = q.trim().toLowerCase()
  if (!t) return []
  const out: LibHit[] = []
  for (const c of LIB.collections) for (const g of c.groups) for (const it of g.items) {
    if (it.kind !== 'doc') continue
    if ((it.title + ' ' + c.title).toLowerCase().includes(t)) {
      out.push({ title: it.title, key: it.key, pdf: it.pdf, file: it.file, ctx: c.title })
      if (out.length >= 40) return out
    }
  }
  return out
}

type View =
  | { kind: 'home' }
  | { kind: 'section'; key: string }
  | { kind: 'article'; id: string; from: View }
  | { kind: 'search' }
  | { kind: 'libcat'; cat: string }
  | { kind: 'collection'; key: string; from: View }

export function HelpCenter() {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [view, setView] = useState<View>({ kind: 'home' })
  const [query, setQuery] = useState('')
  const [docUrls, setDocUrls] = useState<Record<string, string>>({})
  const searchRef = useRef<HTMLInputElement>(null)
  const location = useLocation()

  const suggestions = useMemo(() => suggestionsForPath(location.pathname), [location.pathname])

  useEffect(() => {
    if (!open) return
    setView({ kind: 'home' })
    setQuery('')
    const t = setTimeout(() => searchRef.current?.focus(), 260)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setExpanded(exp => { if (exp) return false; setOpen(false); return exp })
    }
    document.addEventListener('keydown', onKey)
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey) }
  }, [open])

  // Mint short-lived signed URLs for whatever documents the active view shows.
  useEffect(() => {
    let keys: string[] = []
    if (view.kind === 'article') {
      const art = getArticle(view.id)
      if (art) keys = art.body.flatMap(b => (b.t === 'docs' ? b.items.map(i => i.key) : [])).filter((k): k is string => !!k)
    } else if (view.kind === 'collection') {
      const col = getCollection(view.key)
      if (col) keys = col.groups.flatMap(g => g.items.map(i => i.key)).filter((k): k is string => !!k)
    } else if (view.kind === 'search') {
      keys = libSearch(query).map(h => h.key).filter((k): k is string => !!k)
    }
    if (keys.length === 0) return
    let cancelled = false
    supabase.storage.from('documents').createSignedUrls(keys, 3600).then(({ data }) => {
      if (cancelled || !data) return
      setDocUrls(prev => {
        const next = { ...prev }
        for (const it of data) if (it.path && it.signedUrl) next[it.path] = it.signedUrl
        return next
      })
    })
    return () => { cancelled = true }
  }, [view, query])

  function openArticle(id: string) {
    setView(v => ({ kind: 'article', id, from: v.kind === 'article' ? v.from : v }))
  }
  function openCollection(key: string) {
    setView(v => ({ kind: 'collection', key, from: v.kind === 'collection' ? v.from : v }))
  }
  function goBack() {
    if (view.kind === 'article' || view.kind === 'collection') setView(view.from)
    else setView({ kind: 'home' })
  }

  const articleResults = query.trim() ? searchArticles(query) : []
  const docResults = query.trim() ? libSearch(query) : []

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Help & Resources" aria-label="Open help and resources"
        style={{
          width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border-2)',
          background: 'var(--surface-2)', color: 'var(--text-muted)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 700, lineHeight: 1,
        }}
        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)' }}
        onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-2)'; e.currentTarget.style.color = 'var(--text-muted)' }}
      >?</button>

      <div
        onClick={() => setOpen(false)}
        style={{
          position: 'fixed', inset: 0, zIndex: 90, background: 'rgba(3,16,22,0.45)',
          opacity: open ? 1 : 0, visibility: open ? 'visible' : 'hidden', transition: 'opacity 0.2s',
        }}
      />

      <aside
        role="dialog" aria-modal="true" aria-label="Help and Resources"
        style={{
          position: 'fixed', top: 0, right: 0, height: '100vh', zIndex: 100,
          width: expanded ? '100vw' : 'min(420px, 100vw)', background: 'var(--surface)',
          borderLeft: expanded ? 'none' : '1px solid var(--border-2)',
          boxShadow: expanded ? 'none' : '-8px 0 40px rgba(3,16,22,0.4)',
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 0.26s cubic-bezier(0.4,0,0.2,1), width 0.26s cubic-bezier(0.4,0,0.2,1)',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{ background: 'var(--surface-2)', borderBottom: '1px solid var(--border-2)', padding: '14px 16px 16px', flexShrink: 0 }}>
          <div style={{ maxWidth: expanded ? 1100 : 'none', margin: '0 auto', width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: expanded ? 18 : 15, fontWeight: 600, color: 'var(--text)' }}>Help &amp; Resources</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  onClick={() => setExpanded(v => !v)}
                  aria-label={expanded ? 'Collapse to side panel' : 'Expand to full screen'}
                  title={expanded ? 'Collapse to side panel' : 'Expand to full screen'}
                  style={{ width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text-muted)', cursor: 'pointer', display: 'grid', placeItems: 'center' }}
                >
                  {expanded
                    ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 9L4 4M9 9V5M9 9H5M15 15l5 5M15 15v4M15 15h4" /></svg>
                    : <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>}
                </button>
                <button
                  onClick={() => setOpen(false)} aria-label="Close help"
                  style={{ width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border-2)', background: 'var(--surface)', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14 }}
                >✕</button>
              </div>
            </div>
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 8, padding: '8px 11px', maxWidth: expanded ? 560 : 'none' }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
              <input
                ref={searchRef} type="search" value={query}
                onChange={e => { setQuery(e.target.value); setView({ kind: e.target.value.trim() ? 'search' : 'home' }) }}
                placeholder="Search policies, forms, training…"
                style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', color: 'var(--text)', fontSize: 13.5 }}
              />
            </div>
          </div>
        </div>

        {/* Back bar */}
        {(view.kind === 'section' || view.kind === 'article' || view.kind === 'libcat' || view.kind === 'collection') && (
          <button
            onClick={goBack}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left',
              padding: '10px 16px', border: 'none', borderBottom: '1px solid var(--border)',
              background: 'var(--surface-2)', color: 'var(--accent)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
            Back
          </button>
        )}

        {/* Content region: optional category rail (expanded) + scrolling body */}
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {expanded && (
            <nav style={{ width: 240, flexShrink: 0, borderRight: '1px solid var(--border)', overflowY: 'auto', padding: '10px 8px', background: 'var(--surface-2)' }}>
              <RailLabel>Resource library</RailLabel>
              {CATEGORIES.map(cat => {
                const active = view.kind === 'libcat' && view.cat === cat
                return <RailBtn key={cat} label={cat} active={active} onClick={() => setView({ kind: 'libcat', cat })} />
              })}
              <RailLabel>Quick help</RailLabel>
              {QUICK_HELP.map(k => {
                const s = getSection(k)
                if (!s) return null
                return <RailBtn key={k} label={s.label} active={view.kind === 'section' && view.key === k} onClick={() => setView({ kind: 'section', key: k })} />
              })}
            </nav>
          )}

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              <div style={{ maxWidth: expanded ? 880 : 'none', margin: expanded ? '0 auto' : undefined, width: '100%' }}>

                {view.kind === 'home' && (
                  <>
                    <SectionLabel>Suggested for this page</SectionLabel>
                    <div style={{ margin: '0 12px 10px', padding: '4px 12px 10px', background: 'var(--accent-dim)', border: '1px solid var(--border-2)', borderRadius: 9 }}>
                      {suggestions.map(a => <Row key={a.id} article={a} onClick={() => openArticle(a.id)} compact />)}
                    </div>
                    <SectionLabel>Resource library</SectionLabel>
                    {CATEGORIES.map(cat => (
                      <RowRaw key={cat} icon={CAT_ICON[cat] ?? ''} title={cat} sub={`${catCount(cat)} resources`} onClick={() => setView({ kind: 'libcat', cat })} />
                    ))}
                    <SectionLabel>Quick help</SectionLabel>
                    {QUICK_HELP.map(k => {
                      const s = getSection(k)
                      if (!s) return null
                      return <RowRaw key={k} icon={s.icon} title={s.label} sub={s.desc} onClick={() => setView({ kind: 'section', key: k })} />
                    })}
                    <div style={{ padding: '14px 16px 22px', fontSize: 11.5, color: 'var(--text-faint)', lineHeight: 1.5 }}>
                      Recordings are cataloged under M&amp;J University; they open once the media library URL is connected.
                    </div>
                  </>
                )}

                {view.kind === 'libcat' && (
                  <>
                    <SectionLabel>{view.cat}</SectionLabel>
                    {collectionsIn(view.cat).map(c => {
                      const n = c.groups.reduce((m, g) => m + g.items.length, 0)
                      return <RowRaw key={c.key} icon={CAT_ICON[view.cat] ?? ''} title={c.title} sub={`${n} item${n === 1 ? '' : 's'}`} onClick={() => openCollection(c.key)} />
                    })}
                  </>
                )}

                {view.kind === 'collection' && (() => {
                  const col = getCollection(view.key)
                  if (!col) return <div style={{ padding: 20, color: 'var(--text-faint)' }}>Not found.</div>
                  return (
                    <div style={{ padding: '4px 0 30px' }}>
                      <SectionLabel>{col.title}</SectionLabel>
                      {col.groups.map((g, gi) => (
                        <div key={gi} style={{ marginBottom: 6 }}>
                          {(col.groups.length > 1 || g.label !== 'General') && (
                            <div style={{ padding: '10px 16px 4px', fontSize: 12, fontWeight: 700, color: 'var(--text-muted)' }}>{g.label}</div>
                          )}
                          {g.items.map((it, ii) => <LibRow key={ii} item={it} urls={docUrls} />)}
                        </div>
                      ))}
                    </div>
                  )
                })()}

                {view.kind === 'section' && (
                  <>
                    <SectionLabel>{getSection(view.key)?.label}</SectionLabel>
                    {articlesInSection(view.key).map(a => <Row key={a.id} article={a} onClick={() => openArticle(a.id)} />)}
                  </>
                )}

                {view.kind === 'article' && <ArticleView article={getArticle(view.id)} urls={docUrls} />}

                {view.kind === 'search' && (
                  <>
                    {articleResults.length === 0 && docResults.length === 0 ? (
                      <div style={{ padding: '36px 20px', textAlign: 'center', fontSize: 13.5, color: 'var(--text-faint)' }}>
                        No matches for “{query}”. Try “handbook”, “COI”, “budget”, or “inspection”.
                      </div>
                    ) : (
                      <>
                        {articleResults.length > 0 && <SectionLabel>How-to guides</SectionLabel>}
                        {articleResults.map(a => <Row key={a.id} article={a} onClick={() => openArticle(a.id)} showSection />)}
                        {docResults.length > 0 && <SectionLabel>Documents ({docResults.length})</SectionLabel>}
                        {docResults.map((h, i) => (
                          <LibRow key={i} item={{ title: h.title, kind: 'doc', key: h.key, pdf: h.pdf, file: h.file }} urls={docUrls} sub={h.ctx} />
                        ))}
                      </>
                    )}
                  </>
                )}

              </div>
            </div>
          </div>
        </div>
      </aside>
    </>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <div style={{ padding: '14px 16px 6px', fontSize: 10.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 700 }}>{children}</div>
}
function RailLabel({ children }: { children: ReactNode }) {
  return <div style={{ padding: '10px 10px 5px', fontSize: 10, letterSpacing: '0.09em', textTransform: 'uppercase', color: 'var(--text-faint)', fontWeight: 700 }}>{children}</div>
}
function RailBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 7, border: 'none',
      cursor: 'pointer', background: active ? 'var(--accent-dim)' : 'transparent',
      color: active ? 'var(--accent)' : 'var(--text-muted)', fontSize: 13, fontWeight: active ? 600 : 500, marginBottom: 1,
    }}>{label}</button>
  )
}

function splitPaths(path: string): string[] {
  return path.split(' M').map((seg, i) => (i === 0 ? seg : 'M' + seg))
}
function iconEl(path: string) {
  return (
    <span style={{ width: 30, height: 30, borderRadius: 7, background: 'var(--accent-dim)', color: 'var(--accent)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        {splitPaths(path).map((d, i) => <path key={i} d={d} />)}
      </svg>
    </span>
  )
}
const chevron = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-faint)" strokeWidth="2" style={{ flexShrink: 0 }}><path d="M9 18l6-6-6-6" /></svg>

function RowRaw({ icon, title, sub, onClick }: { icon: string; title: string; sub?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left', padding: '11px 16px', border: 'none', borderBottom: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', color: 'var(--text)' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {iconEl(icon)}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13.5, fontWeight: 600, lineHeight: 1.3 }}>{title}</span>
        {sub && <span style={{ display: 'block', fontSize: 12, color: 'var(--text-faint)' }}>{sub}</span>}
      </span>
      {chevron}
    </button>
  )
}

function Row({ article, onClick, showSection, compact }: { article: HelpArticle; onClick: () => void; showSection?: boolean; compact?: boolean }) {
  const sec = getSection(article.section)
  return <RowRaw icon={sec?.icon ?? ''} title={article.title} sub={showSection ? sec?.label : compact ? undefined : article.updated ? `Updated ${article.updated}` : undefined} onClick={onClick} />
}

// A library item: a hosted document (View/Download via signed URL) or a
// recording/handout catalog entry (opens once the media library is connected).
function LibRow({ item, urls, sub }: { item: LibItem; urls: Record<string, string>; sub?: string }) {
  const rowStyle = { display: 'flex', alignItems: 'center', gap: 11, padding: '10px 16px', borderBottom: '1px solid var(--border)', fontSize: 13, textDecoration: 'none' } as const
  const media = item.kind === 'video' || item.kind === 'audio' || item.kind === 'folder'
  const emoji = item.kind === 'video' ? '🎥' : item.kind === 'audio' ? '🎧' : item.kind === 'folder' ? '📁' : null

  if (media) {
    // Recordings/audio live in the shared OneDrive media folder (too large for
    // the document store). Link there; the session sub-folders are preserved.
    if (item.kind === 'video' || item.kind === 'audio') {
      return (
        <a href={MEDIA_FOLDER_URL} target="_blank" rel="noreferrer" style={{ ...rowStyle, color: 'var(--text)' }}
           title={item.loc}
           onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
           onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          <span style={{ fontSize: 16, flexShrink: 0 }}>{emoji}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block' }}>{item.title}</span>
            {sub && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint)' }}>{sub}</span>}
          </span>
          <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, flexShrink: 0 }}>Open folder →</span>
        </a>
      )
    }
    // Handout folders live on the file share, not OneDrive — keep as a note.
    return (
      <div style={{ ...rowStyle, color: 'var(--text-muted)' }} title={item.loc}>
        <span style={{ fontSize: 16, flexShrink: 0 }}>{emoji}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', color: 'var(--text)' }}>{item.title}</span>
          {sub && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint)' }}>{sub}</span>}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)', flexShrink: 0 }}>on file share</span>
      </div>
    )
  }

  let href: string | undefined
  if (item.key) {
    const signed = urls[item.key]
    if (signed) href = item.pdf ? signed : `${signed}&download=${encodeURIComponent(item.file ?? item.title)}`
  }
  const fileIcon = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" style={{ flexShrink: 0 }}><path d="M13 2H6a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M13 2v6h6" /></svg>

  if (!href) {
    return (
      <div style={{ ...rowStyle, color: 'var(--text-faint)' }}>
        {fileIcon}
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', color: 'var(--text)' }}>{item.title}</span>
          {sub && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint)' }}>{sub}</span>}
        </span>
        <span style={{ fontSize: 11, flexShrink: 0 }}>preparing…</span>
      </div>
    )
  }
  return (
    <a href={href} target="_blank" rel="noreferrer" style={{ ...rowStyle, color: 'var(--text)' }}
       onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-2)')}
       onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      {fileIcon}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block' }}>{item.title}</span>
        {sub && <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-faint)' }}>{sub}</span>}
      </span>
      <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, flexShrink: 0 }}>{item.pdf ? 'View' : 'Download'} →</span>
    </a>
  )
}

function ArticleView({ article, urls }: { article: HelpArticle | undefined; urls: Record<string, string> }) {
  if (!article) return <div style={{ padding: 20, color: 'var(--text-faint)' }}>Article not found.</div>
  const sec = getSection(article.section)
  return (
    <div style={{ padding: '18px 18px 40px' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 18, color: 'var(--text)' }}>{article.title}</h2>
      <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginBottom: 14 }}>{sec?.label}{article.updated ? ` · updated ${article.updated}` : ''}</div>
      {article.body.map((b, i) => <Block key={i} b={b} urls={urls} />)}
    </div>
  )
}

function Block({ b, urls }: { b: HelpBlock; urls: Record<string, string> }) {
  const text = { fontSize: 13.5, color: 'var(--text)', lineHeight: 1.55 } as const
  switch (b.t) {
    case 'h': return <h3 style={{ fontSize: 14, margin: '18px 0 8px', color: 'var(--text)' }}>{b.text}</h3>
    case 'p': return <p style={{ ...text, margin: '10px 0' }}>{b.text}</p>
    case 'steps': return <ol style={{ margin: '10px 0', paddingLeft: 20 }}>{b.items.map((it, i) => <li key={i} style={{ ...text, margin: '7px 0' }}>{it}</li>)}</ol>
    case 'list': return <ul style={{ margin: '10px 0', paddingLeft: 20 }}>{b.items.map((it, i) => <li key={i} style={{ ...text, margin: '7px 0' }}>{it}</li>)}</ul>
    case 'note': return <div style={{ margin: '12px 0', padding: '10px 13px', background: 'var(--accent-dim)', borderLeft: '3px solid var(--accent)', borderRadius: '0 8px 8px 0', fontSize: 13, color: 'var(--text-muted)' }}>{b.text}</div>
    case 'docs':
      return (
        <div style={{ margin: '10px 0', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {b.items.map((d, i) => {
            let href = d.href
            if (!href && d.key) { const s = urls[d.key]; if (s) href = d.pdf ? s : `${s}&download=${encodeURIComponent(d.file ?? d.label)}` }
            const rowStyle = { display: 'flex', alignItems: 'center', gap: 9, padding: '9px 11px', border: '1px solid var(--border-2)', borderRadius: 8, background: 'var(--surface-2)', fontSize: 12.5, textDecoration: 'none' } as const
            const icon = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" style={{ flexShrink: 0 }}><path d="M13 2H6a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M13 2v6h6" /></svg>
            if (!href) return <div key={i} style={{ ...rowStyle, color: 'var(--text-faint)' }}>{icon}<span style={{ flex: 1 }}>{d.label}</span><span style={{ fontSize: 11 }}>preparing…</span></div>
            return <a key={i} href={href} target="_blank" rel="noreferrer" style={{ ...rowStyle, color: 'var(--text)' }}>{icon}<span style={{ flex: 1 }}>{d.label}</span><span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 600, flexShrink: 0 }}>{d.pdf ? 'View' : 'Download'} →</span></a>
          })}
        </div>
      )
  }
}
