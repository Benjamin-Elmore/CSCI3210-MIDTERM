import { useEffect, useState } from 'react'
import { getHealth } from './api/health'
import './App.css'

// Each status exposes only the data relevant to that state.
type ConnectionState =
  | { status: 'checking' }
  | { status: 'connected' }
  | { status: 'error'; message: string }

export default function App() {
  const [connection, setConnection] = useState<ConnectionState>({ status: 'checking' })

  useEffect(() => {
    // Cancel requests on unmount, including React StrictMode's development remount.
    const controller = new AbortController()
    void getHealth(controller.signal)
      .then(() => {
        if (!controller.signal.aborted) setConnection({ status: 'connected' })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setConnection({
            status: 'error',
            message: error instanceof Error ? error.message : 'Could not reach the API',
          })
        }
      })
    return () => controller.abort()
  }, [])

  return (
    <main className="shell">
      <p className="eyebrow">CSCI 3210 / Shared pixel canvas</p>
      <h1>
        A little color.<br />
        A shared canvas.
      </h1>
      <p className="intro">A place to build something together, one pixel at a time.</p>
      <section aria-labelledby="status-heading" className="status-card">
        <h2 id="status-heading">Project foundation</h2>
        <p role="status" aria-live="polite">
          {connection.status === 'checking' && 'Connecting to the API...'}
          {connection.status === 'connected' && 'API connected. Ready for the next step.'}
          {connection.status === 'error' &&
            `API unavailable: ${connection.message}. Start the backend and reload.`}
        </p>
        <p className="muted">Accounts, pixel placement, and live updates are coming next.</p>
      </section>
    </main>
  )
}
