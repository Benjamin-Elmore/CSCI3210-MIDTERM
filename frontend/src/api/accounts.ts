import { number, record, request, string } from './client'

export interface User {
  id: number
  username: string
}

export interface Session {
  user: User
  token: string
}

function user(body: unknown): User {
  const data = record(body)
  return { id: number(data.id), username: string(data.username) }
}

export function authenticate(mode: 'login' | 'register', username: string, password: string) {
  return request(`auth/${mode}/`, (body): Session => {
    const data = record(body)
    return { user: user(data.user), token: string(data.token) }
  }, { method: 'POST', data: { username, password } })
}

export function currentUser(token: string, signal: AbortSignal) {
  return request('auth/me/', user, { token, signal })
}

export function logout(token: string) {
  return request('auth/logout/', () => undefined, { method: 'POST', token })
}

const storageKey = 'pixel-canvas-token'

export function storedToken(): string | null {
  try {
    return localStorage.getItem(storageKey)
  } catch {
    return null
  }
}

export function saveToken(token: string | null): void {
  // Some browser privacy modes disable storage; the current session can still work.
  try {
    if (token) localStorage.setItem(storageKey, token)
    else localStorage.removeItem(storageKey)
  } catch { /* Keep the in-memory session when storage is unavailable. */ }
}
