import { useState } from 'react'
import type { FormEvent } from 'react'
import { authenticate } from '../api/accounts'
import type { Session } from '../api/accounts'
import { message } from '../api/client'

export function AuthForm({ onSession }: { onSession: (session: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      onSession(await authenticate(mode, username, password))
    } catch (error) {
      setError(message(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card auth-card" aria-labelledby="auth-title">
      <p className="eyebrow">Your next pixel starts here</p>
      <h2 id="auth-title">{mode === 'login' ? 'Welcome back.' : 'Make your mark.'}</h2>
      <p className="muted">{mode === 'login' ? 'Log in to join the shared canvas.' : 'Create an account to start painting.'}</p>
      <form onSubmit={event => { void submit(event) }}>
        <label htmlFor="username">Username</label>
        <input id="username" name="username" autoComplete="username" required maxLength={150}
          value={username} onChange={event => setUsername(event.target.value)} disabled={busy} />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" required maxLength={128}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          value={password} onChange={event => setPassword(event.target.value)} disabled={busy}
          aria-describedby={mode === 'register' ? 'password-help' : undefined} />
        {mode === 'register' && <p id="password-help" className="muted">Use at least 8 characters. Avoid common passwords and your username.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}</button>
      </form>
      <button className="text-button" disabled={busy} onClick={() => {
        setMode(mode === 'login' ? 'register' : 'login')
        setPassword('')
        setError('')
      }}>{mode === 'login' ? 'New here? Create an account' : 'Already have an account? Log in'}</button>
    </section>
  )
}
