import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api'
import { applyRun, makeWorkflow, type RunRecord, type Workflow } from './model'

export function useWorkflow() {
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [projects, setProjects] = useState<Workflow[]>([])
  const [error, setError] = useState('')
  const [saveState, setSaveState] = useState('正在加载…')
  const [runs, setRuns] = useState<RunRecord[]>([])
  const [activeRun, setActiveRun] = useState<RunRecord | null>(null)
  const [starting, setStarting] = useState(false)
  const [history, setHistory] = useState<{
    past: Workflow[]
    future: Workflow[]
  }>({ past: [], future: [] })
  const saveQueue = useRef(Promise.resolve())
  const latest = useRef<Workflow | null>(null)
  const applied = useRef(new Set<string>())
  const busy = starting || activeRun?.status === 'running'
  const workflowId = workflow?.id
  const activeId = activeRun?.id
  const activeStatus = activeRun?.status

  const save = useCallback((w: Workflow) => {
    setSaveState('保存中…')
    const task = saveQueue.current
      .catch(() => {})
      .then(() => api.saveWorkflow(w))
    saveQueue.current = task
    return task
      .then(() => {
        if (latest.current?.updatedAt === w.updatedAt)
          setSaveState('已保存到本机')
        setProjects((items) => [w, ...items.filter((p) => p.id !== w.id)])
      })
      .catch((e: unknown) => {
        setSaveState('保存失败')
        setError(api.errorMessage(e))
        throw e
      })
  }, [])

  useEffect(() => {
    let disposed = false
    api
      .listWorkflows()
      .then((items) => {
        if (disposed) return
        setProjects(items)
        const w = items[0] ?? makeWorkflow()
        latest.current = w
        setWorkflow(w)
      })
      .catch((e: unknown) => {
        if (!disposed) {
          setError(api.errorMessage(e))
          setSaveState('加载失败')
        }
      })
    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    if (!workflow) return
    const timer = setTimeout(() => {
      void save(workflow).catch(() => {})
    }, 500)
    return () => clearTimeout(timer)
  }, [workflow, save])

  useEffect(() => {
    if (!workflowId) return
    let disposed = false
    api
      .listRuns(workflowId)
      .then((items) => {
        if (disposed) return
        setRuns(items)
        const running = items.find((r) => r.status === 'running')
        setActiveRun(running ?? null)
      })
      .catch((e: unknown) => {
        if (!disposed) setError(api.errorMessage(e))
      })
    return () => {
      disposed = true
    }
  }, [workflowId])

  const change = useCallback(
    (next: Workflow, record = true) => {
      if (busy) return
      const previous = latest.current
      if (record && previous)
        setHistory((h) => ({
          past: [...h.past.slice(-39), previous],
          future: [],
        }))
      const w = { ...next, updatedAt: Date.now() }
      latest.current = w
      setWorkflow(w)
      setSaveState('尚未保存')
    },
    [busy],
  )

  useEffect(() => {
    if (!activeId || activeStatus !== 'running') return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const run = await api.getRun(activeId!)
        if (disposed) return
        setActiveRun(run)
        setRuns((items) => [run, ...items.filter((r) => r.id !== run.id)])
        if (run.status !== 'running' && !applied.current.has(run.id)) {
          applied.current.add(run.id)
          const current = latest.current
          if (current?.id === run.workflowId) {
            const w = { ...applyRun(current, run), updatedAt: Date.now() }
            latest.current = w
            setWorkflow(w)
            setHistory({ past: [], future: [] })
          }
        } else if (run.status === 'running')
          timer = setTimeout(() => {
            void poll()
          }, 700)
      } catch (e) {
        if (!disposed) {
          setError(api.errorMessage(e))
          timer = setTimeout(() => {
            void poll()
          }, 2000)
        }
      }
    }
    void poll()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [activeId, activeStatus])

  async function selectProject(w: Workflow) {
    if (busy) return
    try {
      if (latest.current) await save(latest.current)
      latest.current = w
      setWorkflow(w)
      setHistory({ past: [], future: [] })
      setActiveRun(null)
      setError('')
    } catch {
      /* Keep current unsaved work visible. */
    }
  }
  async function run(target?: string) {
    if (!latest.current || busy) return
    setStarting(true)
    setError('')
    try {
      await save(latest.current)
      const record = await api.startRun(latest.current, target)
      setActiveRun(record)
      setRuns((items) => [record, ...items])
    } catch (e) {
      setError(api.errorMessage(e))
    } finally {
      setStarting(false)
    }
  }
  function undo(redo = false) {
    if (busy || !workflow) return
    const stack = redo ? history.future : history.past
    const next = stack.at(-1)
    if (!next) return
    setHistory(
      redo
        ? { past: [...history.past, workflow], future: stack.slice(0, -1) }
        : { past: stack.slice(0, -1), future: [...history.future, workflow] },
    )
    change(next, false)
  }
  const checkpoint = () => {
    if (!busy && latest.current) {
      const w = latest.current
      setHistory((h) => ({ past: [...h.past.slice(-39), w], future: [] }))
    }
  }
  return {
    workflow,
    projects,
    error,
    setError,
    saveState,
    save,
    change,
    selectProject,
    history,
    undo,
    checkpoint,
    run,
    runs,
    activeRun,
    busy,
    stop: async () => {
      if (activeRun) {
        try {
          await api.cancelRun(activeRun.id)
        } catch (e) {
          setError(api.errorMessage(e))
        }
      }
    },
  }
}
