import { array, number, record, request, string } from './client'

export interface CanvasInfo {
  id: number
  name: string
  slug: string
  width: number
  height: number
  palette: string[]
  cooldown_seconds: number
  version: number
}

export interface Pixel { x: number; y: number; color: string }
export interface Snapshot extends CanvasInfo {
  pixels: Pixel[]
  background_color: string
  next_allowed_at: string | null
  server_time: string
}
export interface Placement extends Pixel {
  id: number
  request_id: string
  version: number
  created_at: string
}
export interface PlacementInput extends Pixel { request_id: string }

function canvas(body: unknown): CanvasInfo {
  const data = record(body)
  return {
    id: number(data.id), name: string(data.name), slug: string(data.slug),
    width: number(data.width), height: number(data.height),
    palette: array(data.palette, string), cooldown_seconds: number(data.cooldown_seconds),
    version: number(data.version),
  }
}

function pixel(body: unknown): Pixel {
  const data = record(body)
  return { x: number(data.x), y: number(data.y), color: string(data.color) }
}

export function decodePlacement(body: unknown): Placement {
  const data = record(body)
  return {
    ...pixel(body), id: number(data.id), request_id: string(data.request_id),
    version: number(data.version), created_at: string(data.created_at),
  }
}

export function listCanvases(token: string, signal: AbortSignal) {
  return request('canvases/', body => array(body, canvas), { token, signal })
}

export function getSnapshot(id: number, token: string, signal?: AbortSignal) {
  return request(`canvases/${id}/snapshot/`, (body): Snapshot => {
    const data = record(body)
    return {
      ...canvas(body), pixels: array(data.pixels, pixel),
      background_color: string(data.background_color),
      next_allowed_at: data.next_allowed_at === null ? null : string(data.next_allowed_at),
      server_time: string(data.server_time),
    }
  }, { token, signal })
}

export function getHistory(id: number, token: string, signal?: AbortSignal) {
  return request(`canvases/${id}/history/`, body => array(record(body).results, decodePlacement), {
    token, signal,
  })
}

export function placePixel(id: number, token: string, data: PlacementInput) {
  return request(`canvases/${id}/placements/`, decodePlacement, { token, method: 'POST', data })
}
