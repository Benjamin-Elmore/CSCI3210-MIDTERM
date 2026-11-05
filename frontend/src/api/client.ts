export class ApiError extends Error {
  readonly status: number
  readonly retryAfter: number

  constructor(message: string, status: number, retryAfter = 0) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

function describeError(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(describeError).join(' ')
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).map(([key, detail]) =>
      `${key === 'detail' || key === 'non_field_errors' ? '' : `${key}: `}${describeError(detail)}`,
    ).join(' ')
  }
  return ''
}

export async function request<T>(
  path: string,
  decode: (body: unknown) => T,
  options: { token?: string; method?: 'POST'; data?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.token) headers.Authorization = `Token ${options.token}`
  if (options.data !== undefined) headers['Content-Type'] = 'application/json'
  const timeout = AbortSignal.timeout(15000)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  let body: unknown
  try {
    response = await fetch(new URL(`/api/${path}`, import.meta.env.VITE_BACKEND_ORIGIN || window.location.origin), {
      method: options.method,
      headers,
      body: options.data === undefined ? undefined : JSON.stringify(options.data),
      signal,
    })
    body = response.status === 204 ? null : await response.json().catch(error => {
      if (signal.aborted) throw error
      return null
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    if (timeout.aborted) throw new Error('The server took too long to respond. Please try again.')
    throw new Error('Could not reach the server. Check your connection and try again.')
  }
  if (!response.ok) {
    const retryAfter = Number(response.headers.get('Retry-After'))
    throw new ApiError(
      describeError(body) || `The server returned HTTP ${response.status}. Please try again.`,
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0,
    )
  }
  return decode(body)
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Unexpected server response. Please try again.')
  }
  return value as Record<string, unknown>
}

export function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid API number.')
  return value
}

export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid API text.')
  return value
}

export function array<T>(value: unknown, decode: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('Invalid API list.')
  return value.map(decode)
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}
