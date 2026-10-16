import { useEffect, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from './api'
import { listSpeechVoices, type SpeechVoiceCatalog } from './mediaApi'

export function useSpeechVoices(baseUrl: string, model: string) {
  const [revision, setRevision] = useState(0)
  const [expiredScope, setExpiredScope] = useState('')
  const scope = JSON.stringify([baseUrl, model, revision])
  const [result, setResult] = useState<{
    scope: string
    catalog?: SpeechVoiceCatalog
    error?: string
  }>()
  const current = result?.scope === scope ? result : undefined
  useEffect(() => {
    if (!current?.catalog) return
    const timer = setTimeout(
      () => setExpiredScope(scope),
      Math.max(0, current.catalog.expiresAt - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [current?.catalog, scope])
  useEffect(() => {
    let alive = true
    if (!isDesktop || !model.trim()) return
    const timer = setTimeout(() => {
      void listSpeechVoices(baseUrl, model).then(
        (catalog) => {
          if (alive) setResult({ scope, catalog })
        },
        (error) => {
          if (alive) setResult({ scope, error: errorMessage(error) })
        },
      )
    }, 400)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [baseUrl, model, scope])
  return {
    catalog: expiredScope === scope ? undefined : current?.catalog,
    error:
      expiredScope === scope
        ? '音色目录已过期，请刷新后再生成。'
        : (current?.error ?? ''),
    loading: isDesktop && !!model.trim() && !current,
    refresh: () => setRevision((r) => r + 1),
  }
}
