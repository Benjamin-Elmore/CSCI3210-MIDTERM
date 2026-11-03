import { useEffect, useRef, useState } from 'react'
import { placePixel } from '../api/canvas'
import type { PlacementInput } from '../api/canvas'
import { useLiveCanvas } from '../hooks/useLiveCanvas'
import { ApiError, message } from '../api/client'
import { maxZoom, overview, PixelCanvas, zoomView } from './PixelCanvas'
import type { Coordinate } from './PixelCanvas'

export function Board({ token, onExpired }: { token: string; onExpired: () => void }) {
  const { board, connection, error: syncError, loading, refresh, receive } = useLiveCanvas(token, onExpired)
  const snapshot = board?.snapshot
  const history = board?.history ?? []
  const [selected, setSelected] = useState<Coordinate>({ x: 0, y: 0 })
  const [view, setView] = useState(overview)
  const [eyedropper, setEyedropper] = useState(false)
  const [color, setColor] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [placing, setPlacing] = useState(false)
  const [readyAt, setReadyAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [pending, setPending] = useState<PlacementInput | null>(null)
  const placingRef = useRef(false)
  const latestLocalVersion = useRef(0)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])

  const palette = snapshot?.palette
  const backgroundColor = snapshot?.background_color
  useEffect(() => {
    if (!palette) return
    setColor(current => palette.includes(current) ? current :
      palette.find(item => item !== backgroundColor) ?? palette[0] ?? '#000000')
  }, [backgroundColor, palette])

  const snapshotVersion = board?.snapshotVersion ?? 0
  const nextAllowedAt = snapshot?.next_allowed_at
  const serverTime = snapshot?.server_time
  useEffect(() => {
    if (!serverTime || snapshotVersion < latestLocalVersion.current) return
    const remaining = nextAllowedAt ? Math.max(0, Date.parse(nextAllowedAt) - Date.parse(serverTime)) : 0
    setReadyAt(Date.now() + remaining)
    setNow(Date.now())
  }, [nextAllowedAt, serverTime, snapshotVersion])

  function select(coordinate: Coordinate) {
    setSelected(coordinate)
    if (!eyedropper || !snapshot) return
    const pixel = snapshot.pixels.find(item => item.x === coordinate.x && item.y === coordinate.y)
    const sampled = pixel?.color ?? snapshot.background_color
    setEyedropper(false)
    if (snapshot.palette.includes(sampled)) {
      setColor(sampled)
      setNotice('Picked ' + sampled + '.')
    } else {
      setNotice('That color is unavailable in the palette.')
    }
  }

  async function place() {
    if (!snapshot || placingRef.current) return
    placingRef.current = true
    setPlacing(true)
    setError('')
    setNotice('')
    // Keep the original ID and payload after an uncertain result to avoid duplicate writes.
    const input = pending ?? { ...selected, color, request_id: crypto.randomUUID() }
    setPending(input)
    try {
      const accepted = await placePixel(snapshot.id, token, input)
      setPending(null)
      latestLocalVersion.current = accepted.version
      receive(accepted)
      setReadyAt(Date.now() + snapshot.cooldown_seconds * 1000)
      setNow(Date.now())
      setNotice(`Pixel saved at (${accepted.x}, ${accepted.y}).`)
      // A retry may return an earlier placement with an already expired cooldown.
      if (pending) refresh()
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) { onExpired(); return }
        if (error.status < 500) setPending(null)
        if (error.status === 429) {
          setReadyAt(Date.now() + error.retryAfter * 1000)
          setNow(Date.now())
        }
      }
      setError(message(error))
    } finally {
      placingRef.current = false
      setPlacing(false)
    }
  }

  const remaining = Math.max(0, Math.ceil((readyAt - now) / 1000))

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
      {snapshot && <div className="workspace">
        <div className="card canvas-card">
          <div className="canvas-meta"><span>{snapshot.width} × {snapshot.height} pixels</span><span role="status">{connection} · Version {snapshot.version}</span></div>
          <div className="canvas-controls" role="group" aria-label="Canvas zoom">
            <button disabled={view.zoom === 1} onClick={() => setView(zoomView(view, view.zoom / 2))}>Zoom out</button>
            <button disabled={view.zoom === maxZoom} onClick={() => setView(zoomView(view, view.zoom * 2))}>Zoom in</button>
            <button disabled={view.zoom === 1} onClick={() => setView(overview)}>Reset view</button>
            <span aria-live="polite">{view.zoom}×</span>
          </div>
          <PixelCanvas snapshot={snapshot} history={history} selected={selected} color={color}
            view={view} onView={setView} onSelect={select} />
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
            <button className="primary" disabled={placing || loading || (!pending && remaining > 0)} onClick={() => { void place() }}>
              {placing ? 'Saving pixel…' : pending ? 'Retry last placement' : remaining > 0 ? `Ready in ${remaining}s` : 'Place pixel'}
            </button>
            <p className="muted">One pixel every {snapshot.cooldown_seconds} seconds. Each accepted placement is saved.</p>
          </section>
          <section className="card history" aria-labelledby="history-title">
            <h2 id="history-title">Recent placements</h2>
            {history.length === 0 ? <p className="muted">A blank canvas. Make the first mark.</p> : <ol>
              {history.map(item => <li key={item.id}>
                <span className="history-color" style={{ backgroundColor: item.color }} aria-label={item.color} />
                <span>({item.x}, {item.y})<small>{new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></span>
                <span className="muted">#{item.version}</span>
              </li>)}
            </ol>}
          </section>
        </aside>
      </div>}
    </section>
  )
}
