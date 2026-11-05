import { useEffect, useState } from 'react'
import { getMyHistory } from '../api/canvas'
import type { Placement } from '../api/canvas'
import { ApiError, message } from '../api/client'

export function PlacementHistory({ canvasId, token, recent, localVersion, snapshotVersion, onExpired }: {
  canvasId: number
  token: string
  recent: Placement[]
  localVersion: number
  snapshotVersion: number
  onExpired: () => void
}) {
  const [mine, setMine] = useState(false)
  const [page, setPage] = useState(1)
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState<Awaited<ReturnType<typeof getMyHistory>> | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!mine) return
    const controller = new AbortController()
    void getMyHistory(canvasId, page, token, controller.signal).then(history => {
      if (controller.signal.aborted) return
      setResult(history)
      setError('')
    }).catch(error => {
      if (controller.signal.aborted) return
      if (error instanceof ApiError && error.status === 401) onExpired()
      else setError(message(error))
    })
    return () => controller.abort()
  }, [canvasId, localVersion, mine, onExpired, page, retry, snapshotVersion, token])

  function changePage(next: number) {
    setPage(next)
    setResult(null)
    setError('')
  }

  const visible = mine ? result?.items ?? [] : recent

  return (
    <section className="card history" aria-labelledby="history-title">
      <h2 id="history-title">{mine ? 'My placements' : 'Recent placements'}</h2>
      <div className="canvas-controls" role="group" aria-label="Placement history filter">
        <button aria-pressed={!mine} onClick={() => setMine(false)}>All placements</button>
        <button aria-pressed={mine} onClick={() => { if (!mine) { changePage(1); setMine(true) } }}>
          My placements
        </button>
      </div>
      {mine && error ? <div>
        <p className="error" role="alert">{error}</p>
        <button onClick={() => { setError(''); setRetry(value => value + 1) }}>Retry history</button>
      </div> : mine && !result ? <p className="muted" role="status">Loading placements…</p> :
        visible.length === 0 ? <p className="muted">{mine ? 'You have no placements yet.' : 'A blank canvas. Make the first mark.'}</p> : <ol>
        {visible.map(item => <li key={item.id}>
          <span className="history-color" style={{ backgroundColor: item.color }} aria-label={item.color} />
          <span>({item.x}, {item.y})<small>{new Date(item.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></span>
          <span className="muted">#{item.version}</span>
        </li>)}
      </ol>}
      {mine && (page > 1 || result?.hasNext) && <div className="history-pages">
        <button disabled={page === 1} onClick={() => changePage(page - 1)}>Newer</button>
        <button disabled={!result?.hasNext} onClick={() => changePage(page + 1)}>Older</button>
      </div>}
    </section>
  )
}
