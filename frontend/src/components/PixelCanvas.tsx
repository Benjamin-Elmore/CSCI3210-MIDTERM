import { useEffect, useRef } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import type { Snapshot } from '../api/canvas'

export interface Coordinate { x: number; y: number }

export function PixelCanvas({ snapshot, selected, color, onSelect }: {
  snapshot: Snapshot
  selected: Coordinate
  color: string
  onSelect: (coordinate: Coordinate) => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const context = ref.current?.getContext('2d')
    if (!context) return
    context.fillStyle = snapshot.background_color
    context.fillRect(0, 0, snapshot.width, snapshot.height)
    for (const pixel of snapshot.pixels) {
      context.fillStyle = pixel.color
      context.fillRect(pixel.x, pixel.y, 1, 1)
    }
  }, [snapshot])

  function select(event: PointerEvent<HTMLCanvasElement>) {
    // The canvas bitmap and its displayed size differ. Scale before rounding.
    const bounds = event.currentTarget.getBoundingClientRect()
    onSelect({
      x: Math.max(0, Math.min(snapshot.width - 1, Math.floor((event.clientX - bounds.left) * snapshot.width / bounds.width))),
      y: Math.max(0, Math.min(snapshot.height - 1, Math.floor((event.clientY - bounds.top) * snapshot.height / bounds.height))),
    })
  }

  function move(event: KeyboardEvent<HTMLCanvasElement>) {
    const delta: Record<string, Coordinate> = {
      ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
    }
    const direction = delta[event.key]
    if (!direction) return
    event.preventDefault()
    onSelect({
      x: Math.max(0, Math.min(snapshot.width - 1, selected.x + direction.x)),
      y: Math.max(0, Math.min(snapshot.height - 1, selected.y + direction.y)),
    })
  }

  return (
    <div className="canvas-frame" style={{ aspectRatio: `${snapshot.width} / ${snapshot.height}` }}>
      <canvas ref={ref} width={snapshot.width} height={snapshot.height} tabIndex={0}
        aria-label={`${snapshot.name}. Select a pixel with a click, tap, or arrow keys. Selected pixel ${selected.x}, ${selected.y}.`}
        onPointerDown={select} onKeyDown={move}>
        Your browser needs canvas support to display the board.
      </canvas>
      <span className="pixel-selection" aria-hidden="true" style={{
        left: `${selected.x / snapshot.width * 100}%`, top: `${selected.y / snapshot.height * 100}%`,
        width: `${100 / snapshot.width}%`, height: `${100 / snapshot.height}%`, backgroundColor: color,
      }} />
    </div>
  )
}
