import { useEffect, useRef, useState } from 'react'
import { getSnapshot, listCanvases } from '../api/canvas'
import type { Placement } from '../api/canvas'
import { decodeCanvasEvent, subscribeToCanvas } from '../api/canvasSocket'
import { ApiError, message } from '../api/client'

type BoardState = Awaited<ReturnType<typeof getSnapshot>> & { snapshotVersion: number }
type Connection = 'Connecting' | 'Live' | 'Resyncing' | 'Reconnecting'

export function useLiveCanvas(token: string, onExpired: () => void) {
  const [board, setBoard] = useState<BoardState | null>(null)
  const [connection, setConnection] = useState<Connection>('Connecting')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const refreshRef = useRef<() => void>(() => {})
  const receiveRef = useRef<(placement: Placement) => void>(() => {})

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
    let retryDelay = 500
    let reconnectTimer: number | undefined
    let syncTimer: number | undefined

    function flush() {
      if (!current) return
      for (const version of pending.keys()) {
        if (version <= current.snapshot.version) pending.delete(version)
      }

      let next = pending.get(current.snapshot.version + 1)
      while (next) {
        const previous: BoardState = current
        const { snapshot, history } = previous
        const { x, y, color, version } = next
        const pixels = snapshot.pixels.filter(pixel => pixel.x !== x || pixel.y !== y)
        current = {
          snapshot: { ...snapshot, version, pixels: [...pixels, { x, y, color }] },
          snapshotVersion: previous.snapshotVersion,
          history: [next, ...history].slice(0, 50),
        }
        pending.delete(version)
        next = pending.get(version + 1)
      }
      setBoard(current)
    }

    function scheduleSync() {
      if (syncTimer !== undefined) return
      syncTimer = window.setTimeout(() => {
        syncTimer = undefined
        void synchronize()
      }, 500)
    }

    async function synchronize() {
      if (fetching) {
        refreshAgain = true
        return
      }

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
        const snapshot = await getSnapshot(canvasId, token, signal)
        if (signal.aborted) return
        current = { ...snapshot, snapshotVersion: snapshot.snapshot.version }
        flush()
        setError('')
        if (pending.size) scheduleSync()
        else if (connected && !refreshAgain) setConnection('Live')
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof ApiError && error.status === 401) onExpired()
        else {
          setError(message(error))
          if (connected) scheduleSync()
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
      if (current && placement.version <= current.snapshot.version) return
      pending.set(placement.version, placement)
      if (fetching || !current) return
      flush()
      if (pending.size) {
        if (connected) setConnection('Resyncing')
        scheduleSync()
      }
    }

    function connect(id: number) {
      const connectionSocket = subscribeToCanvas(id, token)
      socket = connectionSocket
      connectionSocket.onopen = () => {
        if (signal.aborted) return
        connected = true
        retryDelay = 500
        // The group has been joined. Buffer anything that arrives during the snapshot.
        void synchronize()
      }
      connectionSocket.onmessage = event => {
        if (signal.aborted) return
        try {
          receive(decodeCanvasEvent(event.data))
        } catch {
          void synchronize()
        }
      }
      connectionSocket.onclose = () => {
        if (signal.aborted) return
        connected = false
        setConnection('Reconnecting')
        reconnectTimer = window.setTimeout(() => {
          connect(id)
          // This also checks for an expired HTTP token if the handshake was rejected.
          void synchronize()
        }, retryDelay)
        retryDelay = Math.min(retryDelay * 2, 8000)
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

  return {
    board, connection, error, loading,
    refresh: () => refreshRef.current(),
    receive: (placement: Placement) => receiveRef.current(placement),
  }
}
