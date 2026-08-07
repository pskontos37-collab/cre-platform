// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { ErrorBoundary } from '../ErrorBoundary'

// React logs every caught error to console.error; silence it so a passing run
// is not full of red noise, and restore afterwards.
let spy: ReturnType<typeof vi.spyOn>
beforeEach(() => { spy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { spy.mockRestore(); cleanup() })

function Boom({ when = true }: { when?: boolean }) {
  if (when) throw new Error('kaboom from the page')
  return <div>page content</div>
}

describe('ErrorBoundary', () => {
  it('renders children untouched when nothing throws', () => {
    render(<ErrorBoundary><div>page content</div></ErrorBoundary>)
    expect(screen.getByText('page content')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('catches a render throw and shows the message instead of a blank region', () => {
    render(<ErrorBoundary label="/pcf"><Boom /></ErrorBoundary>)
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('This section could not be displayed')
    // The actual error text must reach the user — that is the whole point.
    expect(alert.textContent).toContain('kaboom from the page')
  })

  it('records the failure on window so it can be read back without a screenshot', () => {
    render(<ErrorBoundary label="/pcf"><Boom /></ErrorBoundary>)
    const last = (window as unknown as { __creLastError?: { message: string; label: string } }).__creLastError
    expect(last?.message).toBe('kaboom from the page')
    expect(last?.label).toBe('/pcf')
  })

  it('recovers when resetKey changes — the navigate-away case', () => {
    // This is the behaviour that matters in the app: without it, one thrown
    // page would leave the boundary broken for the rest of the session even
    // after the user navigates somewhere that works.
    const { rerender } = render(
      <ErrorBoundary resetKey="/pcf"><Boom /></ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeTruthy()

    rerender(
      <ErrorBoundary resetKey="/financials"><Boom when={false} /></ErrorBoundary>,
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('page content')).toBeTruthy()
  })

  it('does NOT reset when the resetKey is unchanged', () => {
    // Same route re-rendering must not clear the error, or the boundary would
    // thrash between fallback and a re-throwing child.
    const { rerender } = render(
      <ErrorBoundary resetKey="/pcf"><Boom /></ErrorBoundary>,
    )
    rerender(<ErrorBoundary resetKey="/pcf"><Boom /></ErrorBoundary>)
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('"Try again" clears the error so a transient failure can re-render', () => {
    function Flaky({ failRef }: { failRef: { fail: boolean } }) {
      if (failRef.fail) throw new Error('transient')
      return <div>recovered content</div>
    }
    const ref = { fail: true }
    render(<ErrorBoundary><Flaky failRef={ref} /></ErrorBoundary>)
    expect(screen.getByRole('alert')).toBeTruthy()

    ref.fail = false // the underlying cause goes away (e.g. a retried fetch)
    fireEvent.click(screen.getByText('Try again'))
    expect(screen.getByText('recovered content')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
