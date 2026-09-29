import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from './api'
import * as api from './mediaApi'

const size = (bytes: number) =>
  bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(2)} GB`
    : `${(bytes / 1_000_000).toFixed(1)} MB`

export function ComfyModelManager() {
  const [catalog, setCatalog] = useState<api.ComfyModelCatalog | null>(null)
  const [progress, setProgress] = useState<api.ComfyModelProgress | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [accepted, setAccepted] = useState(false)
  const [token, setToken] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [downloading, setDownloading] = useState(false)

  async function refresh() {
    const next = await api.getComfyModelCatalog()
    setCatalog(next)
    setProgress(next.active)
    setDownloading(!!next.active)
    setSelectedId((current) => current || next.models[0]?.id || '')
  }

  useEffect(() => {
    if (!isDesktop) return
    let alive = true
    const unlisteners: Array<() => void> = []
    void (async () => {
      const progressListener = await listen<api.ComfyModelProgress>(
        'comfy-model-progress',
        (event) => {
          if (alive) {
            setProgress(event.payload)
            setDownloading(true)
          }
        },
      )
      if (!alive) return progressListener()
      unlisteners.push(progressListener)
      const finishedListener = await listen<string>(
        'comfy-model-finished',
        () => {
          if (alive) {
            setDownloading(false)
            void refresh().catch((e: unknown) => setError(errorMessage(e)))
          }
        },
      )
      if (!alive) return finishedListener()
      unlisteners.push(finishedListener)
      await refresh()
    })().catch((e: unknown) => {
      if (alive) setError(errorMessage(e))
    })
    return () => {
      alive = false
      unlisteners.forEach((unlisten) => unlisten())
    }
  }, [])

  const selected = catalog?.models.find((model) => model.id === selectedId)
  const remaining = selected
    ? Math.max(0, selected.bytes - selected.partialBytes)
    : 0

  async function chooseDirectory() {
    setBusy(true)
    setError('')
    try {
      const path = await api.chooseComfyModelsDirectory()
      if (path) {
        setMessage(`已选择 ${path}`)
        await refresh()
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function startDownload() {
    if (!selected) return
    setDownloading(true)
    setError('')
    setMessage('下载中；关闭应用后可从临时文件续传。')
    const submittedToken = token.trim()
    setToken('')
    try {
      await api.downloadComfyModel(selected.id, submittedToken)
      setMessage(
        `${selected.name} 下载并校验完成。重启 ComfyUI 后可在工作流中选择。`,
      )
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setDownloading(false)
      await refresh().catch((e: unknown) => setError(errorMessage(e)))
    }
  }

  return (
    <details className="comfy-model-manager">
      <summary>可选下载 FLUX / LoRA 模型</summary>
      <p className="field-hint">
        模型单独下载到现有 ComfyUI 的 models 文件夹；云端生图无需下载。FLUX
        请使用自定义 API 工作流，内置 SD 工作流不适用。
      </p>
      <div className="comfy-model-actions">
        <button
          type="button"
          className="small-button"
          disabled={!isDesktop || busy || downloading}
          onClick={() => void chooseDirectory()}
        >
          选择 models 文件夹
        </button>
        <button
          type="button"
          className="text-button"
          disabled={!isDesktop || busy}
          onClick={() =>
            void refresh().catch((e: unknown) => setError(errorMessage(e)))
          }
        >
          刷新文件状态
        </button>
      </div>
      <p className="field-hint">
        目录：{catalog?.directory ?? '尚未选择'}
        {catalog?.availableBytes != null &&
          ` · 剩余空间 ${size(catalog.availableBytes)}`}
      </p>
      <label className="field-label">
        下载模型
        <select
          aria-label="可选 ComfyUI 模型"
          value={selectedId}
          onChange={(event) => {
            setSelectedId(event.target.value)
            setAccepted(false)
            setError('')
          }}
        >
          {catalog?.models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name} · {size(model.bytes)}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <>
          <p className="field-hint">
            {selected.note} 文件：{selected.fileName}；许可：{selected.license}
            。{' '}
            <a href={selected.pageUrl} target="_blank" rel="noreferrer">
              查看模型与许可
            </a>
          </p>
          <p className="field-hint">
            {selected.installedBytes != null
              ? `目标文件已存在（${size(selected.installedBytes)}，未校验；应用不会覆盖）`
              : selected.partialBytes > 0
                ? `可续传 ${size(selected.partialBytes)} / ${size(selected.bytes)}`
                : `需下载 ${size(selected.bytes)}`}
            {catalog?.availableBytes != null &&
              selected.installedBytes == null &&
              catalog.availableBytes < remaining + 128 * 1024 * 1024 &&
              ' · 磁盘空间不足'}
          </p>
          <label className="field-label">
            Hugging Face Token（仓库要求时填写，仅用于本次下载）
            <input
              aria-label="Hugging Face Token"
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <label className="comfy-model-consent">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            我已查看模型页面，并确认适用该模型的许可和下载体积
          </label>
          <div className="comfy-model-actions">
            <button
              type="button"
              className="small-button"
              disabled={
                !isDesktop ||
                !catalog?.directory ||
                !accepted ||
                selected.installedBytes != null ||
                downloading ||
                busy ||
                (catalog.availableBytes != null &&
                  catalog.availableBytes < remaining + 128 * 1024 * 1024)
              }
              onClick={() => void startDownload()}
            >
              {selected.partialBytes ? '继续下载' : '开始下载'}
            </button>
            {downloading && (
              <button
                type="button"
                className="small-button"
                onClick={() =>
                  void api
                    .pauseComfyModelDownload()
                    .catch((e: unknown) => setError(errorMessage(e)))
                }
              >
                暂停下载
              </button>
            )}
          </div>
        </>
      )}
      {progress && downloading && (
        <div role="status">
          {progress.status} · {size(progress.completed)} /{' '}
          {size(progress.total)}
          <progress value={progress.completed} max={progress.total} />
        </div>
      )}
      {message && (
        <p className="field-hint" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="workflow-error" role="alert">
          {error}
        </p>
      )}
    </details>
  )
}
