import { decodePlacement } from './canvas'
import { record } from './client'

export function subscribeToCanvas(id: number, token: string) {
  const url = new URL(`/ws/canvases/${id}/`, window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(url, ['pixel-canvas.v1', `token.${token}`])
}

export function decodeCanvasEvent(payload: string) {
  const event = record(JSON.parse(payload))
  if (event.type !== 'placement') throw new Error('Unknown canvas event.')
  return decodePlacement(event.placement)
}
