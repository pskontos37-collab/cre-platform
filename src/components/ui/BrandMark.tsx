/** The M&J Wilkow quadrant-and-ampersand mark, recreated as an inline SVG so it
 *  scales crisply and needs no image asset. Colors are fixed brand values. */
export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-label="M&J Wilkow">
      <rect x="0"  y="0"  width="50" height="50" fill="#16394b" />
      <rect x="50" y="0"  width="50" height="50" fill="#8fb3cf" />
      <rect x="0"  y="50" width="50" height="50" fill="#4e7e9e" />
      <rect x="50" y="50" width="50" height="50" fill="#64828f" />
      <text
        x="52"
        y="78"
        textAnchor="middle"
        fontFamily="Cinzel, 'Trajan Pro', Georgia, serif"
        fontSize="86"
        fontWeight={600}
        fill="#123647"
      >
        &amp;
      </text>
    </svg>
  )
}

/** Serif brand wordmark, matching the corporate identity. */
export function BrandWordmark({ size = 15 }: { size?: number }) {
  return (
    <span
      style={{
        fontFamily:    "Cinzel, 'Trajan Pro', Georgia, serif",
        fontWeight:    600,
        fontSize:      size,
        letterSpacing: '0.10em',
        color:         'var(--text-muted)',
        whiteSpace:    'nowrap',
      }}
    >
      M&amp;J&nbsp;WILKOW
    </span>
  )
}
