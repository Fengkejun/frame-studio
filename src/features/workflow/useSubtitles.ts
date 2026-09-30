import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import * as api from './mediaApi'
import { errorMessage } from './api'

export function useSubtitles(
  workflowId: string,
  setAssets: Dispatch<SetStateAction<api.SubtitleAsset[]>>,
  setError: (message: string) => void,
) {
  const [jobs, setJobs] = useState<api.TranscriptionJob[]>([])
  const active = jobs.some(api.isTranscriptionRunning)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    async function read() {
      try {
        const values = await api.listTranscriptionJobs(workflowId)
        const assets = await api.listSubtitleAssets(workflowId)
        if (alive) {
          setAssets(assets)
          setJobs(values)
        }
        if (alive && values.some(api.isTranscriptionRunning))
          timer = setTimeout(() => void read(), 800)
      } catch (reason) {
        if (alive) {
          setError(errorMessage(reason))
          if (active) timer = setTimeout(() => void read(), 1500)
        }
      }
    }
    void read()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [workflowId, active, setAssets, setError])
  return { jobs, setJobs, active }
}
