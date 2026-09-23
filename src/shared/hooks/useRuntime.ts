import { useEffect, useState } from 'react'
import { getAppInfo, isDesktop } from '@/shared/lib/desktop'
import type { RuntimeStatus } from '@/shared/types/desktop'

export function useRuntime() {
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<RuntimeStatus>(
    isDesktop ? { state: 'loading' } : { state: 'browser' },
  )

  useEffect(() => {
    if (!isDesktop) return
    let disposed = false
    getAppInfo().then(
      (info) => {
        if (!disposed) setStatus({ state: 'ready', info })
      },
      (error: unknown) => {
        if (!disposed) {
          setStatus({
            state: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      },
    )
    return () => {
      disposed = true
    }
  }, [attempt])

  const retry = () => {
    if (!isDesktop) return
    setStatus({ state: 'loading' })
    setAttempt((value) => value + 1)
  }

  return { status, retry }
}
