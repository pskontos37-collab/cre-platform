interface EmptyStateProps {
  icon?: string
  title: string
  subtitle?: string
}

export function EmptyState({ icon = '📭', title, subtitle }: EmptyStateProps) {
  return (
    <div style={{ textAlign: 'center', padding: '24px 16px', color: 'var(--text-faint)' }}>
      <div style={{ fontSize: 28, marginBottom: 8 }}>{icon}</div>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 4 }}>{title}</div>
      {subtitle && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{subtitle}</div>}
    </div>
  )
}
