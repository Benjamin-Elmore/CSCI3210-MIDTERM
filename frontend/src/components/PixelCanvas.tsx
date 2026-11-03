import { useEffect, useRef } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import type { Placement, Snapshot } from '../api/canvas'

export interface Coordinate { x: number; y: number }
export interface CanvasView extends Coordinate { zoom: number }

export const overview: CanvasView = { x: 0.5, y: 0.5, zoom: 1 }
export const maxZoom = 16

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function zoomView(view: CanvasView, zoom: number): CanvasView {
  return zoom === 1 ? overview : { ...view, zoom }
}

export function PixelCanvas({ snapshot, history, selected, color, view, onView, onSelect }: {
  snapshot: Snapshot
  history: Placement[]
  selected: Coordinate
  color: string
  view: CanvasView
  onView: (view: CanvasView) => void
  onSelect: (coordinate: Coordinate) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const drawn = useRef<Snapshot | null>(null)
  const drag = useRef<{ id: number; x: number; y: number; view: CanvasView; moved: boolean } | null>(null)

  useEffect(() => {
    const context = ref.current?.getContext('2d')
    if (!context) return
    const previous = drawn.current
    const updates = previous && previous.id === snapshot.id && previous.server_time === snapshot.server_time
      ? history.filter(item => item.version > previous.version && item.version <= snapshot.version).reverse()
      : null
    const incremental = previous && updates && updates.length === snapshot.version - previous.version
    if (!incremental) {
      context.fillStyle = snapshot.background_color
      context.fillRect(0, 0, snapshot.width, snapshot.height)
    }
    for (const pixel of incremental ? updates : snapshot.pixels) {
      context.fillStyle = pixel.color
      context.fillRect(pixel.x, pixel.y, 1, 1)
    }
    drawn.current = snapshot
  }, [history, snapshot])

  function startDrag(event: PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || drag.current) return
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, view, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function pan(event: PointerEvent<HTMLCanvasElement>) {
    const start = drag.current
    const bounds = frame.current?.getBoundingClientRect()
    if (!start || start.id !== event.pointerId || !bounds) return
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (!start.moved && Math.hypot(dx, dy) < 5) return
    start.moved = true
    if (start.view.zoom === 1) return
    onView({
      zoom: start.view.zoom,
      x: clamp(start.view.x - dx / (bounds.width * start.view.zoom), 0, 1),
      y: clamp(start.view.y - dy / (bounds.height * start.view.zoom), 0, 1),
    })
  }

  function endDrag(event: PointerEvent<HTMLCanvasElement>) {
    const start = drag.current
    if (!start || start.id !== event.pointerId) return
    drag.current = null
    if (start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) >= 5) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = Math.floor((event.clientX - bounds.left) * snapshot.width / bounds.width)
    const y = Math.floor((event.clientY - bounds.top) * snapshot.height / bounds.height)
    if (x >= 0 && x < snapshot.width && y >= 0 && y < snapshot.height) onSelect({ x, y })
  }

  useEffect(() => {
    const element = frame.current
    if (!element) return
    function wheelZoom(event: WheelEvent) {
      if (!element || !event.deltaY || event.ctrlKey || drag.current) return
      const zoom = clamp(view.zoom * (event.deltaY < 0 ? 2 : 0.5), 1, maxZoom)
      if (zoom === view.zoom) return
      event.preventDefault()
      const bounds = element.getBoundingClientRect()
      const dx = (event.clientX - bounds.left) / bounds.width - 0.5
      const dy = (event.clientY - bounds.top) / bounds.height - 0.5
      onView(zoomView({
        ...view,
        x: clamp(view.x + dx * (1 / view.zoom - 1 / zoom), 0, 1),
        y: clamp(view.y + dy * (1 / view.zoom - 1 / zoom), 0, 1),
      }, zoom))
    }

    element.addEventListener('wheel', wheelZoom, { passive: false })
    return () => element.removeEventListener('wheel', wheelZoom)
  }, [onView, view])

  function move(event: KeyboardEvent<HTMLCanvasElement>) {
    const delta: Record<string, Coordinate> = {
      ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
    }
    const direction = delta[event.key]
    if (!direction) return
    event.preventDefault()
    const next = {
      x: clamp(selected.x + direction.x, 0, snapshot.width - 1),
      y: clamp(selected.y + direction.y, 0, snapshot.height - 1),
    }
    const x = (next.x + 0.5) / snapshot.width
    const y = (next.y + 0.5) / snapshot.height
    const half = 0.5 / view.zoom
    if (Math.abs(x - view.x) >= half || Math.abs(y - view.y) >= half) onView({ ...view, x, y })
    onSelect(next)
  }

  return (
    <div ref={frame} className="canvas-frame"
      style={{ aspectRatio: snapshot.width + ' / ' + snapshot.height }}>
      <div className="canvas-layer" style={{
        transform: 'translate(' + (0.5 - view.x * view.zoom) * 100 + '%, ' +
          (0.5 - view.y * view.zoom) * 100 + '%) scale(' + view.zoom + ')',
      }}>
        <canvas ref={ref} width={snapshot.width} height={snapshot.height} tabIndex={0}
          aria-label={snapshot.name + '. Select a pixel with a click, tap, or arrow keys. Selected pixel ' + selected.x + ', ' + selected.y + '.'}
          onPointerDown={startDrag} onPointerMove={pan} onPointerUp={endDrag}
          onLostPointerCapture={event => { if (drag.current?.id === event.pointerId) drag.current = null }}
          onKeyDown={move}>
          Your browser needs canvas support to display the board.
        </canvas>
        <span className="pixel-selection" aria-hidden="true" style={{
          left: selected.x / snapshot.width * 100 + '%', top: selected.y / snapshot.height * 100 + '%',
          width: 100 / snapshot.width + '%', height: 100 / snapshot.height + '%',
          backgroundColor: color, outlineWidth: 1 / view.zoom, boxShadow: '0 0 0 ' + 2 / view.zoom + 'px #192c27',
        }} />
      </div>
    </div>
  )
}
