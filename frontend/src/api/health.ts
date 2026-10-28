export interface HealthResponse {
  status: 'ok'
  service: 'pixel-canvas-api'
}

export async function getHealth(signal: AbortSignal): Promise<HealthResponse> {
  // Vite forwards this same-origin path to Django during development.
  const response = await fetch('/api/health/', { signal })
  if (!response.ok) throw new Error(`API returned HTTP ${response.status}`)

  // TypeScript cannot validate network data; check its shape before using it.
  const body: unknown = await response.json()
  if (
    typeof body !== 'object' ||
    body === null ||
    !('status' in body) ||
    body.status !== 'ok' ||
    !('service' in body) ||
    body.service !== 'pixel-canvas-api'
  ) {
    throw new Error('Unexpected API response')
  }

  return { status: body.status, service: body.service }
}
