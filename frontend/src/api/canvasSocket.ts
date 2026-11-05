import { decodePlacement } from './canvas'
import { number, record } from './client'

export function subscribeToCanvas(id: number, token: string) {
  const url = new URL(`/ws/canvases/${id}/`, import.meta.env.VITE_BACKEND_ORIGIN || window.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(url, ['pixel-canvas.v1', `token.${token}`])
}

export function decodeCanvasEvent(payload: string) {
  const event = record(JSON.parse(payload))
  if (event.type === 'placement') {
    return { type: 'placement', placement: decodePlacement(event.placement) } as const
  }
  if (event.type === 'version') {
    const version = number(event.version)
    if (Number.isSafeInteger(version) && version >= 0) return { type: 'version', version } as const
  }
  throw new Error('Unknown canvas event.')
}
