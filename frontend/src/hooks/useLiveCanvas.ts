import { useCallback, useEffect, useRef, useState } from 'react'
import { getSnapshot, listCanvases } from '../api/canvas'
import type { Pixel, Placement, SnapshotMetadata } from '../api/canvas'
import { decodeCanvasEvent, subscribeToCanvas } from '../api/canvasSocket'
import { ApiError, message } from '../api/client'

type PixelRows = ReadonlyArray<ReadonlyMap<number, Pixel>>
type BoardState = {
  snapshot: SnapshotMetadata
  version: number
  pixels: PixelRows
  history: Placement[]
  readyAt: number
}
type Connection = 'Connecting' | 'Live' | 'Resyncing' | 'Reconnecting'

function pixelRows(height: number, pixels: Pixel[]): PixelRows {
  const rows = Array.from({ length: height }, () => new Map<number, Pixel>())
  for (const pixel of pixels) rows[pixel.y].set(pixel.x, pixel)
  return rows
}

function cooldownDeadline(snapshot: SnapshotMetadata) {
  if (!snapshot.next_allowed_at) return 0
  const remaining = Date.parse(snapshot.next_allowed_at) - Date.parse(snapshot.server_time)
  return remaining > 0 ? Date.now() + remaining : 0
}

export function useLiveCanvas(token: string, onExpired: () => void) {
  const [board, setBoard] = useState<BoardState | null>(null)
  const [connection, setConnection] = useState<Connection>('Connecting')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const refreshRef = useRef<() => void>(() => {})
  const receiveRef = useRef<(placement: Placement) => void>(() => {})
  const refresh = useCallback(() => refreshRef.current(), [])
  const acceptPlacement = useCallback((placement: Placement) => receiveRef.current(placement), [])

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    const pending = new Map<number, Placement>()
    let current: BoardState | null = null
    let socket: WebSocket | undefined
    let canvasId: number | undefined
    let connected = false
    let fetching = false
    let refreshAgain = false
    let latestKnownVersion = 0
    let reconnectDelay = 500
    let syncDelay = 500
    let reconnectTimer: number | undefined
    let syncTimer: number | undefined

    function flush() {
      if (!current) return
      for (const version of pending.keys()) {
        if (version <= current.version) pending.delete(version)
      }

      const updates: Placement[] = []
      let version = current.version
      for (let next = pending.get(version + 1); next; next = pending.get(version + 1)) {
        updates.push(next)
        version = next.version
        pending.delete(version)
      }

      if (updates.length) {
        // Reuse untouched rows and copy each changed row at most once per batch.
        const pixels = [...current.pixels]
        const changedRows = new Map<number, Map<number, Pixel>>()
        for (const update of updates) {
          let row = changedRows.get(update.y)
          if (!row) {
            row = new Map(pixels[update.y])
            changedRows.set(update.y, row)
            pixels[update.y] = row
          }
          row.set(update.x, update)
        }
        current = {
          ...current, version, pixels,
          history: [...updates.reverse(), ...current.history].slice(0, 50),
        }
      }

      setBoard(current)
    }

    function scheduleSync() {
      if (syncTimer !== undefined) return
      syncTimer = window.setTimeout(() => {
        syncTimer = undefined
        void synchronize()
      }, syncDelay)
      syncDelay = Math.min(syncDelay * 2, 8000)
    }

    function checkVersion() {
      if (!current || fetching || latestKnownVersion <= current.version) return
      if (connected) setConnection('Resyncing')
      scheduleSync()
    }

    async function synchronize() {
      if (signal.aborted) return
      if (fetching) {
        refreshAgain = true
        return
      }

      window.clearTimeout(syncTimer)
      syncTimer = undefined
      fetching = true
      if (connected) setConnection('Resyncing')
      try {
        if (canvasId === undefined) {
          const canvases = await listCanvases(token, signal)
          if (signal.aborted) return
          const canvas = canvases.find(item => item.slug === 'main') ?? canvases[0]
          if (!canvas) throw new Error('No canvas is available yet. Please try again later.')
          canvasId = canvas.id
          connect(canvasId)
        }
        const { snapshot: { pixels, ...snapshot }, history } = await getSnapshot(canvasId, token, signal)
        if (signal.aborted) return
        if (!current || snapshot.version >= current.version) {
          current = {
            snapshot, history, version: snapshot.version,
            pixels: pixelRows(snapshot.height, pixels), readyAt: cooldownDeadline(snapshot),
          }
        }
        flush()
        setError('')
        if (latestKnownVersion > current.version) scheduleSync()
        else {
          syncDelay = 500
          if (connected && !refreshAgain) setConnection('Live')
        }
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof ApiError && error.status === 401) {
          controller.abort()
          onExpired()
        } else {
          setError(message(error))
          scheduleSync()
        }
      } finally {
        fetching = false
        if (!signal.aborted) {
          setLoading(false)
          if (refreshAgain) {
            refreshAgain = false
            void synchronize()
          }
        }
      }
    }

    function receive(placement: Placement) {
      if (signal.aborted || (current && placement.version <= current.version)) return
      latestKnownVersion = Math.max(latestKnownVersion, placement.version)
      pending.set(placement.version, placement)
      if (fetching || !current) return
      flush()
      checkVersion()
    }

    function reconnect(id: number) {
      connected = false
      setConnection('Reconnecting')
      reconnectTimer = window.setTimeout(() => {
        connect(id)
        // Check for an expired HTTP token if the handshake was rejected.
        void synchronize()
      }, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, 8000)
    }

    function connect(id: number) {
      if (signal.aborted) return
      let connectionSocket: WebSocket
      try {
        connectionSocket = subscribeToCanvas(id, token)
      } catch {
        reconnect(id)
        return
      }
      socket = connectionSocket
      connectionSocket.onopen = () => {
        if (signal.aborted) return
        connected = true
        reconnectDelay = 500
        // The group has been joined. Buffer events that arrive during the snapshot.
        void synchronize()
      }
      connectionSocket.onmessage = event => {
        if (signal.aborted) return
        try {
          const update = decodeCanvasEvent(event.data)
          if (update.type === 'placement') receive(update.placement)
          else {
            latestKnownVersion = Math.max(latestKnownVersion, update.version)
            checkVersion()
          }
        } catch {
          scheduleSync()
        }
      }
      connectionSocket.onclose = () => {
        if (!signal.aborted) reconnect(id)
      }
    }

    refreshRef.current = () => { void synchronize() }
    receiveRef.current = receive
    void synchronize()
    return () => {
      controller.abort()
      window.clearTimeout(reconnectTimer)
      window.clearTimeout(syncTimer)
      socket?.close()
    }
  }, [token, onExpired])

  return { board, connection, error, loading, refresh, receive: acceptPlacement }
}
