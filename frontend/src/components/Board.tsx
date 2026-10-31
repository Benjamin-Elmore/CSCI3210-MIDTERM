import { useEffect, useRef, useState } from 'react'
import { getHistory, getSnapshot, listCanvases, placePixel } from '../api/canvas'
import type { Placement, PlacementInput, Snapshot } from '../api/canvas'
import { ApiError, message } from '../api/client'
import { PixelCanvas } from './PixelCanvas'
import type { Coordinate } from './PixelCanvas'

export function Board({ token, onExpired }: { token: string; onExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [history, setHistory] = useState<Placement[]>([])
  const [selected, setSelected] = useState<Coordinate>({ x: 0, y: 0 })
  const [color, setColor] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [placing, setPlacing] = useState(false)
  const [reload, setReload] = useState(0)
  const [readyAt, setReadyAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [pending, setPending] = useState<PlacementInput | null>(null)
  const placingRef = useRef(false)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setLoading(true)
      setError('')
      try {
        const canvases = await listCanvases(token, controller.signal)
        const canvas = canvases.find(item => item.slug === 'main') ?? canvases[0]
        if (!canvas) throw new Error('No canvas is available yet. Please try again later.')
        const [board, placements] = await Promise.all([
          getSnapshot(canvas.id, token, controller.signal),
          getHistory(canvas.id, token, controller.signal),
        ])
        if (controller.signal.aborted) return
        setSnapshot(board)
        setHistory(placements)
        setColor(current => board.palette.includes(current) ? current :
          board.palette.find(item => item !== board.background_color) ?? board.palette[0] ?? '#000000')
        // Use the server's time difference rather than relying on the client's clock.
        const remaining = board.next_allowed_at
          ? Math.max(0, Date.parse(board.next_allowed_at) - Date.parse(board.server_time)) : 0
        setReadyAt(Date.now() + remaining)
        setNow(Date.now())
      } catch (error) {
        if (controller.signal.aborted) return
        if (error instanceof ApiError && error.status === 401) onExpired()
        else setError(message(error))
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }
    void load()
    return () => controller.abort()
  }, [token, reload, onExpired])

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
      setSnapshot(board => board ? {
        ...board,
        version: Math.max(board.version, accepted.version),
        pixels: [...board.pixels.filter(pixel => pixel.x !== accepted.x || pixel.y !== accepted.y), accepted],
      } : null)
      setHistory(items => [accepted, ...items.filter(item => item.id !== accepted.id)].slice(0, 50))
      setReadyAt(Date.now() + snapshot.cooldown_seconds * 1000)
      setNow(Date.now())
      setNotice(`Pixel saved at (${accepted.x}, ${accepted.y}). Refresh the page to see it again.`)
      // Reload authoritative cooldowns, including the original time for successful retries.
      setReload(value => value + 1)
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
        <button disabled={loading || placing} onClick={() => { setNotice(''); setReload(value => value + 1) }}>
          {loading ? 'Loading…' : 'Refresh canvas'}
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="notice" role="status" aria-live="polite">{notice || (loading ? 'Loading canvas and history…' : '')}</p>
      {snapshot && <div className="workspace">
        <div className="card canvas-card">
          <div className="canvas-meta"><span>{snapshot.width} × {snapshot.height} pixels</span><span>Version {snapshot.version}</span></div>
          <PixelCanvas snapshot={snapshot} selected={selected} color={color} onSelect={setSelected} />
          <p className="muted">Click or tap a pixel to select it. You can also focus the canvas and use the arrow keys.</p>
        </div>
        <aside className="tools">
          <section className="card" aria-labelledby="palette-title">
            <h2 id="palette-title">Pick your color</h2>
            <div className="palette" role="group" aria-label="Color palette">
              {snapshot.palette.map(item => <button key={item} className="swatch" style={{ backgroundColor: item }}
                aria-label={`Color ${item}`} aria-pressed={item === color} title={item}
                onClick={() => setColor(item)} />)}
            </div>
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
      <p className="muted footer-note">Use Refresh canvas to load other players’ changes.</p>
    </section>
  )
}
