import { useCallback, useEffect, useState } from 'react'
import { currentUser, logout, saveToken, storedToken } from './api/accounts'
import type { Session } from './api/accounts'
import { ApiError, message } from './api/client'
import { AuthForm } from './components/AuthForm'
import { Board } from './components/Board'
import './App.css'

export default function App() {
  const [token, setToken] = useState(storedToken)
  const [session, setSession] = useState<Session | null>(null)
  const [checking, setChecking] = useState(Boolean(token))
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [loggingOut, setLoggingOut] = useState(false)

  const expired = useCallback(() => {
    setChecking(false)
    saveToken(null)
    setToken(null)
    setSession(null)
    setError('Your session has expired. Please log in again.')
  }, [])

  const activeToken = session?.token
  useEffect(() => {
    if (!token || token === activeToken) return
    const controller = new AbortController()
    void currentUser(token, controller.signal).then(user => {
      if (!controller.signal.aborted) {
        setSession({ user, token })
        setChecking(false)
      }
    }).catch(error => {
      if (controller.signal.aborted) return
      if (error instanceof ApiError && error.status === 401) expired()
      else setError(message(error))
    }).finally(() => {
      if (!controller.signal.aborted) setChecking(false)
    })
    return () => controller.abort()
  }, [activeToken, token, retry, expired])

  function signedIn(value: Session) {
    setChecking(false)
    saveToken(value.token)
    setError('')
    setSession(value)
    setToken(value.token)
  }

  async function signOut() {
    if (!session || loggingOut) return
    setLoggingOut(true)
    setError('')
    try {
      await logout(session.token)
      setChecking(false)
      saveToken(null)
      setToken(null)
      setSession(null)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) expired()
      else setError(`Could not log out. ${message(error)}`)
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <main className="shell">
      <header className="site-header">
        <a className="brand" href={import.meta.env.BASE_URL} aria-label="Pixel Commons home"><span className="brand-mark" aria-hidden="true">▦</span> Pixel Commons</a>
        {session && <div className="account-menu"><span>{session.user.username}</span><button disabled={loggingOut} onClick={() => { void signOut() }}>{loggingOut ? 'Logging out…' : 'Log out'}</button></div>}
      </header>
      {error && <p className="error" role="alert">{error}</p>}
      {checking ? <p role="status">Restoring your session…</p> : session ?
        <Board key={session.token} token={session.token} onExpired={expired} /> : token ?
          <section className="card"><h1>Let’s reconnect.</h1><p>We could not restore your session.</p><button onClick={() => { setChecking(true); setError(''); setRetry(value => value + 1) }}>Try again</button></section> :
          <div className="welcome-layout">
            <section className="welcome"><p className="eyebrow">A small contribution. A collective creation.</p>
              <h1>A little color.<br />A shared canvas.</h1>
              <p className="intro">Choose a color, find your spot, and add a pixel. Build something together, one mark at a time.</p>
              <div className="pixel-art" aria-hidden="true">{Array.from({ length: 64 }, (_, index) => <span key={index} />)}</div>
              <p className="muted">100 × 100 possibilities. What will you add?</p>
            </section>
            <AuthForm onSession={signedIn} />
          </div>}
    </main>
  )
}
