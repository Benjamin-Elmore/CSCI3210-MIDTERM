import { useCallback, useSyncExternalStore } from 'react'

export function PlacePixelButton({ readyAt, placing, retrying, loading, onPlace }: {
  readyAt: number
  placing: boolean
  retrying: boolean
  loading: boolean
  onPlace: () => void
}) {
  const deadline = retrying || placing ? 0 : readyAt
  const getRemaining = useCallback(() => Math.max(0, Math.ceil((deadline - Date.now()) / 1000)), [deadline])
  const subscribe = useCallback((notify: () => void) => {
    let timer: number | undefined
    function schedule() {
      const timeLeft = deadline - Date.now()
      if (timeLeft <= 0) return
      timer = window.setTimeout(() => {
        notify()
        schedule()
      }, timeLeft % 1000 || 1000)
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [deadline])
  const remaining = useSyncExternalStore(subscribe, getRemaining)

  return (
    <button className="primary" disabled={placing || loading || remaining > 0} onClick={onPlace}>
      {placing ? 'Saving pixel…' : retrying ? 'Retry last placement' : remaining > 0 ? `Ready in ${remaining}s` : 'Place pixel'}
    </button>
  )
}
