import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { placePixel } from '../api/canvas'
import type { CanvasInfo, PlacementInput, SnapshotMetadata } from '../api/canvas'
import { useLiveCanvas } from '../hooks/useLiveCanvas'
import { ApiError, message } from '../api/client'
import { maxZoom, overview, zoomView } from './canvasView'
import type { Coordinate } from './canvasView'
import { PixelCanvas } from './PixelCanvas'
import { PlacementHistory } from './PlacementHistory'
import { PlacePixelButton } from './PlacePixelButton'

function coordinateFrom(x: string, y: string, snapshot: CanvasInfo): Coordinate | null {
  if (!/^\d+$/.test(x) || !/^\d+$/.test(y)) return null
  const coordinate = { x: Number(x), y: Number(y) }
  return coordinate.x < snapshot.width && coordinate.y < snapshot.height ? coordinate : null
}

function centeredView(coordinate: Coordinate, snapshot: CanvasInfo, zoom: number) {
  return {
    x: (coordinate.x + 0.5) / snapshot.width,
    y: (coordinate.y + 0.5) / snapshot.height,
    zoom: Math.max(4, zoom),
  }
}

export function Board({ token, onExpired }: { token: string; onExpired: () => void }) {
  const { board, connection, error: syncError, loading, refresh, receive } = useLiveCanvas(token, onExpired)
  const snapshot = board?.snapshot
  const [selected, setSelected] = useState<Coordinate>({ x: 0, y: 0 })
  const [view, setView] = useState(overview)
  const [linkOpened, setLinkOpened] = useState(false)
  const [shareFallback, setShareFallback] = useState('')
  const [jumpError, setJumpError] = useState('')
  const [eyedropper, setEyedropper] = useState(false)
  const [selectedColor, setColor] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [placing, setPlacing] = useState(false)
  const [localCooldown, setLocalCooldown] = useState<{ snapshot: SnapshotMetadata; version: number; readyAt: number } | null>(null)
  const [localVersion, setLocalVersion] = useState(0)
  const [pending, setPending] = useState<PlacementInput | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const placingRef = useRef(false)
  const palette = snapshot?.palette
  const color = palette?.includes(selectedColor) ? selectedColor :
    palette?.find(item => item !== snapshot?.background_color) ?? palette?.[0] ?? ''
  // A snapshot must include the accepted placement before its cooldown can replace ours.
  const useLocalCooldown = localCooldown && snapshot &&
    (snapshot === localCooldown.snapshot || snapshot.version < localCooldown.version)
  const readyAt = useLocalCooldown ? localCooldown.readyAt : board?.readyAt ?? 0

  if (snapshot && !linkOpened) {
    setLinkOpened(true)
    const query = new URLSearchParams(window.location.search)
    const coordinate = coordinateFrom(query.get('x') ?? '', query.get('y') ?? '', snapshot)
    if (coordinate) {
      setSelected(coordinate)
      setView(centeredView(coordinate, snapshot, view.zoom))
    }
  }

  async function sharePixel() {
    const url = new URL(window.location.pathname, window.location.origin)
    url.searchParams.set('x', String(selected.x))
    url.searchParams.set('y', String(selected.y))
    try {
      await navigator.clipboard.writeText(url.href)
      setShareFallback('')
      setNotice('Pixel link copied.')
    } catch {
      setShareFallback(url.href)
      setNotice('Copy the pixel link from the field below.')
    }
  }

  function exportPng() {
    const canvas = canvasRef.current
    if (!canvas || !snapshot) return
    const filename = snapshot.slug + '.png'
    canvas.toBlob(blob => {
      if (!blob) {
        setNotice('Could not export the canvas.')
        return
      }
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, 'image/png')
  }

  function jump(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!snapshot) return
    const data = new FormData(event.currentTarget)
    const coordinate = coordinateFrom(String(data.get('x')), String(data.get('y')), snapshot)
    if (!coordinate) {
      setJumpError('Enter whole coordinates from 0 to ' + (snapshot.width - 1) + ' for X and 0 to ' + (snapshot.height - 1) + ' for Y.')
      return
    }
    setJumpError('')
    setEyedropper(false)
    setSelected(coordinate)
    setView(centeredView(coordinate, snapshot, view.zoom))
  }

  function select(coordinate: Coordinate) {
    setSelected(coordinate)
    if (!eyedropper || !board) return
    const pixel = board.pixels[coordinate.y]?.get(coordinate.x)
    const sampled = pixel?.color ?? board.snapshot.background_color
    setEyedropper(false)
    if (board.snapshot.palette.includes(sampled)) {
      setColor(sampled)
      setNotice('Picked ' + sampled + '.')
    } else {
      setNotice('That color is unavailable in the palette.')
    }
  }

  async function place() {
    if (!board || placingRef.current || (!pending && readyAt > Date.now())) return
    const { snapshot } = board
    placingRef.current = true
    setPlacing(true)
    setError('')
    setNotice('')
    try {
      // Keep the original ID and payload after an uncertain result to avoid duplicate writes.
      const input = pending ?? { ...selected, color, request_id: crypto.randomUUID() }
      setPending(input)
      const accepted = await placePixel(snapshot.id, token, input)
      setPending(null)
      setLocalVersion(accepted.version)
      receive(accepted)
      setLocalCooldown({ snapshot, version: accepted.version, readyAt: Date.now() + snapshot.cooldown_seconds * 1000 })
      setNotice(`Pixel saved at (${accepted.x}, ${accepted.y}).`)
      // A retry may return an earlier placement with an already expired cooldown.
      if (pending) refresh()
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) { onExpired(); return }
        if (error.status < 500 && error.status !== 408) setPending(null)
        if (error.status === 429) {
          setLocalCooldown({ snapshot, version: board.version, readyAt: Date.now() + error.retryAfter * 1000 })
          refresh()
        }
      }
      setError(message(error))
    } finally {
      placingRef.current = false
      setPlacing(false)
    }
  }

  return (
    <section aria-label="Shared canvas">
      <div className="board-heading">
        <div><p className="eyebrow">One pixel. A shared picture.</p><h1>{snapshot?.name ?? 'Your canvas'}</h1></div>
        <button disabled={loading || placing} onClick={() => { setNotice(''); setError(''); refresh() }}>
          {loading ? 'Loading…' : 'Refresh canvas'}
        </button>
      </div>
      {(error || syncError) && <p className="error" role="alert">{error || syncError}</p>}
      <p className="notice" role="status" aria-live="polite">{notice || (loading ? 'Loading canvas and history…' : '')}</p>
      {board && snapshot && <div className="workspace">
        <div className="card canvas-card">
          <div className="canvas-meta"><span>{snapshot.width} × {snapshot.height} pixels</span><span role="status">{connection} · Version {board.version}</span></div>
          <div className="canvas-controls" role="group" aria-label="Canvas zoom">
            <button disabled={view.zoom === 1} onClick={() => setView(zoomView(view, view.zoom / 2))}>Zoom out</button>
            <button disabled={view.zoom === maxZoom} onClick={() => setView(zoomView(view, view.zoom * 2))}>Zoom in</button>
            <button disabled={view.zoom === 1} onClick={() => setView(overview)}>Reset view</button>
            <span aria-live="polite">{view.zoom}×</span>
            <button onClick={exportPng}>Export PNG</button>
            <button onClick={() => { void sharePixel() }}>Copy pixel link</button>
          </div>
          {shareFallback && <label>Pixel link
            <input readOnly value={shareFallback} onFocus={event => event.currentTarget.select()} />
          </label>}
          <form className="coordinate-jump" onSubmit={jump}>
            <label>X <input name="x" inputMode="numeric" defaultValue="0" required /></label>
            <label>Y <input name="y" inputMode="numeric" defaultValue="0" required /></label>
            <button type="submit">Jump to pixel</button>
          </form>
          {jumpError && <p className="error" role="alert">{jumpError}</p>}
          <PixelCanvas snapshot={snapshot} version={board.version} pixels={board.pixels} history={board.history}
            selected={selected} color={color} view={view} canvasRef={canvasRef} onView={setView} onSelect={select} />
          <p className="muted">Click, tap, or use the arrow keys to select a pixel. Scroll or use the buttons to zoom, then drag to pan.</p>
        </div>
        <aside className="tools">
          <section className="card" aria-labelledby="palette-title">
            <h2 id="palette-title">Pick your color</h2>
            <div className="palette" role="group" aria-label="Color palette">
              {snapshot.palette.map(item => <button key={item} className="swatch" style={{ backgroundColor: item }}
                aria-label={`Color ${item}`} aria-pressed={item === color} title={item}
                onClick={() => { setColor(item); setEyedropper(false) }} />)}
            </div>
            <button className="eyedropper" aria-pressed={eyedropper} onClick={() => setEyedropper(active => !active)}>
              Eyedropper
            </button>
            {eyedropper && <p className="muted" role="status">Select a pixel to pick its color.</p>}
            <div className="selection-summary"><span className="color-preview" style={{ backgroundColor: color }} />
              <span><strong>{color}</strong><br /><span className="muted">Pixel ({selected.x}, {selected.y})</span></span>
            </div>
            {pending && !placing && <p className="muted">The last request could not be confirmed. Retry to check the original pixel ({pending.x}, {pending.y}).</p>}
            <PlacePixelButton readyAt={readyAt} placing={placing} retrying={Boolean(pending)} loading={loading}
              onPlace={() => { void place() }} />
            <p className="muted">One pixel every {snapshot.cooldown_seconds} seconds. Each accepted placement is saved.</p>
          </section>
          <PlacementHistory canvasId={snapshot.id} token={token} recent={board.history} localVersion={localVersion}
            snapshotVersion={snapshot.version} onExpired={onExpired} />
        </aside>
      </div>}
    </section>
  )
}
