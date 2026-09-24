import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './mediaApi'
import { errorMessage } from './api'

export function useMedia(workflowId?: string) {
  const [data, setData] = useState<{
    assets: api.ImageAsset[]
    frames: api.FirstFrame[]
    jobs: api.ImageJob[]
    cloudJobs: api.CloudImageJob[]
    roleReferences: api.RoleReference[]
  }>({ assets: [], frames: [], jobs: [], cloudJobs: [], roleReferences: [] })
  const [error, setError] = useState('')
  const current = useRef(workflowId)
  const generation = useRef(0)
  useEffect(() => {
    current.current = workflowId
    return () => {
      current.current = undefined
    }
  }, [workflowId])
  const refresh = useCallback(async () => {
    if (!workflowId) return
    const revision = ++generation.current
    const [assets, frames, jobs, cloudJobs, roleReferences] = await Promise.all(
      [
        api.listImageAssets(),
        api.listFirstFrames(workflowId),
        api.listImageJobs(workflowId),
        api.listCloudImageJobs(workflowId),
        api.listRoleReferences(workflowId),
      ],
    )
    if (current.current === workflowId && revision === generation.current)
      setData({ assets, frames, jobs, cloudJobs, roleReferences })
  }, [workflowId])
  useEffect(() => {
    let alive = true
    void refresh().catch((e) => {
      if (alive) setError(errorMessage(e))
    })
    return () => {
      alive = false
    }
  }, [refresh])
  const jobs = data.jobs.filter(
    (job) => job.request.context.workflowId === workflowId,
  )
  const frames = data.frames.filter(
    (frame) => frame.context.workflowId === workflowId,
  )
  const cloudJobs = data.cloudJobs.filter(
    (job) => job.request.context.workflowId === workflowId,
  )
  const running =
    jobs.some(api.isImageRunning) || cloudJobs.some(api.isCloudImageRunning)
  useEffect(() => {
    if (!running) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        await refresh()
      } catch (e) {
        if (!disposed) setError(errorMessage(e))
      }
      if (!disposed) timer = setTimeout(() => void poll(), 1200)
    }
    timer = setTimeout(() => void poll(), 1200)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [running, refresh])
  return {
    assets: data.assets,
    frames,
    jobs,
    cloudJobs,
    roleReferences: data.roleReferences,
    error,
    setError,
    refresh,
    running,
  }
}
