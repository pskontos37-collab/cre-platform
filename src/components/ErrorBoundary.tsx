import { Component, type ErrorInfo, type ReactNode } from 'react'

// KI-5. A render-time throw in React unmounts the whole subtree, and without a
// boundary that subtree is the page: the user gets a blank region with no
// message and no way back. That is not hypothetical here — the first live PCF
// test 500'd and rendered NOTHING below the toolbar, because loading was false,
// data was null, and every render branch was therefore false.
//
// This boundary is mounted inside AppLayout (so the sidebar and header survive
// and the user can navigate away) and again at the root (so a failure in the
// layout itself still produces a readable screen instead of white).
//
// Deliberately NOT a monitoring service: adding one is an owner decision with a
// cost attached. What this does is make a failure visible, recoverable, and
// reportable. Durable capture is tracked separately in KI-5.

interface Props {
  children: ReactNode
  // Changing this clears a caught error. AppLayout passes the pathname, so
  // navigating to a working page recovers on its own — without it the boundary
  // would stay broken for the rest of the session once anything threw.
  resetKey?: string
  // Shown above the error so the message names the area that failed.
  label?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Grouped and prefixed so it is findable in a noisy console, and parked on
    // window so it can be read back without a screenshot (CDP screenshots time
    // out against this app; innerText and window reads are the reliable path).
    console.error(`[cre-error] ${this.props.label ?? 'app'}:`, error, info.componentStack)
    ;(window as unknown as { __creLastError?: unknown }).__creLastError = {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
      label: this.props.label ?? 'app',
      at: new Date().toISOString(),
    }
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div
        role="alert"
        style={{
          margin: '24px auto', maxWidth: 640, padding: '20px 22px',
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 10, color: 'var(--text)',
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>
          This section could not be displayed
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.5 }}>
          The rest of the app still works — use the sidebar to move to another page. If this
          keeps happening, send the detail below.
        </div>

        <pre
          style={{
            fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            background: 'var(--surface-2)', border: '1px solid var(--border-2)',
            borderRadius: 6, padding: '10px 12px', margin: '0 0 14px',
            color: 'var(--text-muted)', maxHeight: 180, overflowY: 'auto',
          }}
        >
          {error.message || String(error)}
        </pre>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              fontSize: 13, padding: '7px 14px', borderRadius: 6, cursor: 'pointer',
              background: 'var(--accent)', color: '#fff', border: '1px solid var(--accent)',
            }}
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              fontSize: 13, padding: '7px 14px', borderRadius: 6, cursor: 'pointer',
              background: 'transparent', color: 'var(--text)', border: '1px solid var(--border-2)',
            }}
          >
            Reload page
          </button>
        </div>
      </div>
    )
  }
}
