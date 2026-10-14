import { useEffect, useState } from 'react'
import { errorMessage } from './api'
import * as api from './backupApi'
import type { Workflow } from './model'

const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`

export function BackupPanel({
  workflow,
  disabled,
  onSave,
  onRestore,
}: {
  workflow: Workflow
  disabled: boolean
  onSave: (workflow: Workflow) => Promise<void>
  onRestore: (workflow: Workflow) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<api.BackupReport | null>(null)
  const [selected, setSelected] = useState('')
  const [working, setWorking] = useState(false)
  const [loading, setLoading] = useState(false)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!open) return
    let ignore = false
    api
      .listBackups()
      .then((next) => {
        if (!ignore) {
          setReport(next)
          setSelected((previous) =>
            next.points.some((p) => p.id === previous)
              ? previous
              : (next.points[0]?.id ?? ''),
          )
        }
      })
      .catch((e: unknown) => {
        if (!ignore) setError(errorMessage(e))
      })
      .finally(() => {
        if (!ignore) setLoading(false)
      })
    return () => {
      ignore = true
    }
  }, [open, revision])
  const point = report?.points.find((p) => p.id === selected)
  const busy = disabled || working || loading
  function refresh() {
    setLoading(true)
    setError('')
    setRevision((n) => n + 1)
  }
  async function act(kind: 'choose' | 'create' | 'restore') {
    if (busy) return
    setWorking(true)
    setError('')
    setNotice('')
    try {
      if (kind === 'choose') {
        const directory = await api.chooseBackupDirectory()
        if (directory) refresh()
      } else {
        await onSave(workflow)
        if (kind === 'create') {
          const created = await api.createBackup(workflow.id)
          setSelected(created.id)
          setNotice(
            `备份已完成：新增 ${size(created.newBytes)}，复用 ${size(created.reusedBytes)}。`,
          )
          refresh()
        } else if (point) {
          const restored = await api.restoreBackup(point.id)
          await onRestore(restored)
        }
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setWorking(false)
    }
  }
  return (
    <details
      className="backup-panel"
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open
        if (next && !open) {
          setLoading(true)
          setError('')
        }
        setOpen(next)
      }}
    >
      <summary>项目备份与恢复</summary>
      {open && (
        <section aria-label="项目备份与恢复">
          <p className="field-hint">
            备份当前项目及其素材版本。重复素材会复用已有副本；恢复会新建项目，保留当前项目。
          </p>
          <p className="backup-location">
            {report?.directory ?? '尚未选择备份位置'}
          </p>
          <div className="backup-actions">
            <button
              className="small-button"
              disabled={busy}
              onClick={() => void act('choose')}
            >
              选择备份位置
            </button>
            <button
              className="small-button"
              disabled={busy || !report?.directory}
              onClick={() => void act('create')}
            >
              备份当前项目
            </button>
            <button className="small-button" disabled={busy} onClick={refresh}>
              刷新备份记录
            </button>
            {busy && (
              <span className="field-hint" role="status">
                {working ? '正在处理备份素材，请稍候…' : '正在读取备份记录…'}
              </span>
            )}
          </div>
          {error && (
            <p className="workflow-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="field-hint" role="status">
              {notice}
            </p>
          )}
          {!!report?.warnings.length && (
            <p className="workflow-error" role="alert">
              {report.warnings.length}{' '}
              条备份记录异常，已跳过。请检查备份磁盘或换一个备份位置。
            </p>
          )}
          {!!report?.points.length && (
            <div className="backup-history">
              <label>
                备份记录
                <select
                  aria-label="备份记录"
                  value={selected}
                  disabled={busy}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {report.points.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.projectName} · {new Date(p.createdAt).toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
              {point && (
                <p className="field-hint">
                  {point.fileCount} 个文件 · 素材共 {size(point.totalBytes)} ·
                  本次新增 {size(point.newBytes)} · 复用{' '}
                  {size(point.reusedBytes)}
                </p>
              )}
              <button
                className="small-button"
                disabled={busy || !point}
                onClick={() => void act('restore')}
              >
                恢复为新项目
              </button>
            </div>
          )}
          {report?.directory && !report.points.length && !loading && (
            <p className="field-hint">这个位置还没有可用的备份记录。</p>
          )}
          <p className="field-hint">
            迁移备份时请复制整个 FrameStudioBackups 文件夹。API
            Key、模型连接、任务历史与回收区素材保留在原设备。
          </p>
        </section>
      )}
    </details>
  )
}
