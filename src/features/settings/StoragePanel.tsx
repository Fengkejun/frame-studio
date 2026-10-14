import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from '@/features/workflow/api'
import './storage.css'

interface Item {
  id: string
  kind: 'image' | 'video' | 'audio'
  name: string
  bytes: number
  status: string
}
interface Report {
  assetBytes: number
  databaseBytes: number
  otherBytes: number
  trashBytes: number
  protectedCount: number
  cleanableCount: number
  cleanableBytes: number
  busy: boolean
  groups: { kind: Item['kind']; count: number; bytes: number }[]
  candidates: Item[]
  trash: Item[]
}
const kinds = { image: '图片', video: '视频', audio: '音频' }
function size(bytes: number) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : bytes >= 1024
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${bytes} B`
}
export function StoragePanel() {
  const [report, setReport] = useState<Report | null>(null)
  const [working, setWorking] = useState(isDesktop)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [plan, setPlan] = useState<
    { kind: 'move'; items: Item[] } | { kind: 'purge'; items: [Item] } | null
  >(null)
  const [confirmed, setConfirmed] = useState(false)
  const refresh = useCallback(async (preserveError = false) => {
    if (!isDesktop) return
    setWorking(true)
    if (!preserveError) setError('')
    try {
      setReport(await invoke<Report>('get_storage_report'))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setWorking(false)
    }
  }, [])
  useEffect(() => {
    if (!isDesktop) return
    let alive = true
    void invoke<Report>('get_storage_report')
      .then((data) => {
        if (alive) setReport(data)
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e))
      })
      .finally(() => {
        if (alive) setWorking(false)
      })
    return () => {
      alive = false
    }
  }, [])
  const chosen = report?.candidates.filter((i) => selected.includes(i.id)) ?? []
  const blocked = working || !!report?.busy || !isDesktop
  async function run(action: () => Promise<void>, message: string) {
    setWorking(true)
    setError('')
    setNotice('')
    try {
      await action()
      setNotice(message)
      setPlan(null)
      setConfirmed(false)
      setSelected([])
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      await refresh(true)
    }
  }
  function preview(kind: 'move' | 'purge', items: Item[]) {
    const first = items[0]
    if (!first) return
    setConfirmed(false)
    setPlan(kind === 'purge' ? { kind, items: [first] } : { kind, items })
    setNotice('')
  }
  return (
    <section className="settings-section storage-panel" aria-label="素材与存储">
      <h2>素材与存储</h2>
      <p>
        查看当前设备全部项目的素材占用。先移入回收区，可恢复原版本；永久删除后才释放磁盘空间。
      </p>
      {!isDesktop && (
        <p className="field-hint">请在桌面应用中查看与清理本机素材。</p>
      )}
      <button
        className="small-button"
        disabled={working || !isDesktop || !!plan}
        onClick={() => void refresh()}
      >
        {working ? '处理中…' : '刷新占用统计'}
      </button>
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
      {report && (
        <>
          <dl className="storage-totals">
            <div>
              <dt>素材与回收区</dt>
              <dd>{size(report.assetBytes + report.trashBytes)}</dd>
            </div>
            <div>
              <dt>项目数据</dt>
              <dd>{size(report.databaseBytes)}</dd>
            </div>
            <div>
              <dt>可清理素材</dt>
              <dd>
                {report.cleanableCount} 个 · {size(report.cleanableBytes)}
              </dd>
            </div>
            <div>
              <dt>回收区占用</dt>
              <dd>{size(report.trashBytes)}</dd>
            </div>
          </dl>
          <p className="field-hint">
            已保护 {report.protectedCount}{' '}
            个素材版本。首帧、角色参考、片段选择、时间线、历史成片和任务输入的引用均参与检查。
          </p>
          <ul className="storage-groups">
            {report.groups.map((g) => (
              <li key={g.kind}>
                {kinds[g.kind]} · {g.count} 个 · {size(g.bytes)}
              </li>
            ))}
          </ul>
          {!!report.otherBytes && (
            <p className="field-hint">
              其他素材文件 {size(report.otherBytes)}，保留供人工检查。
            </p>
          )}
          {report.busy && (
            <p role="status">有任务正在运行，请完成或暂停后再清理。</p>
          )}
          <details open>
            <summary>清理预览 · 未引用候选</summary>
            <p className="field-hint">
              每次最多选择 100 个。列表最多显示 500 项，提交前会再次检查引用。
            </p>
            <button
              className="text-button"
              disabled={blocked || !!plan}
              onClick={() =>
                setSelected(report.candidates.slice(0, 100).map((i) => i.id))
              }
            >
              选择前 100 个候选
            </button>
            <div className="storage-list">
              {report.candidates.map((i) => (
                <label className="storage-row" key={i.id}>
                  <input
                    type="checkbox"
                    aria-label={`选择素材 ${i.name}`}
                    checked={selected.includes(i.id)}
                    disabled={
                      blocked ||
                      !!plan ||
                      (chosen.length >= 100 && !selected.includes(i.id))
                    }
                    onChange={(e) =>
                      setSelected((v) =>
                        e.target.checked
                          ? [...v, i.id]
                          : v.filter((id) => id !== i.id),
                      )
                    }
                  />
                  <span>
                    <strong>{i.name}</strong>
                    <small>
                      {kinds[i.kind]} · 版本 {i.id.slice(0, 8)}
                    </small>
                  </span>
                  <span>{size(i.bytes)}</span>
                </label>
              ))}
            </div>
            {!report.candidates.length && (
              <p className="field-hint">当前没有可清理的未引用素材。</p>
            )}
            <button
              className="small-button"
              disabled={blocked || !chosen.length || !!plan}
              onClick={() => preview('move', chosen)}
            >
              预览清理计划
            </button>
          </details>
          {plan && (
            <fieldset className="storage-confirm">
              <legend>
                {plan.kind === 'move' ? '确认移入回收区' : '确认永久删除'}
              </legend>
              <p>
                {plan.items.length} 个素材 ·{' '}
                {size(plan.items.reduce((sum, i) => sum + i.bytes, 0))}
              </p>
              <ul>
                {plan.items.map((i) => (
                  <li key={i.id}>
                    {i.name} · {kinds[i.kind]}
                  </li>
                ))}
              </ul>
              <p>
                {plan.kind === 'move'
                  ? '回收区保留原文件与版本信息，可在下方恢复。'
                  : '这将永久删除回收文件，恢复需使用其他备份。'}
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={working}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {plan.kind === 'move'
                  ? '已核对清理列表'
                  : '确认永久删除这些回收文件'}
              </label>
              <div className="form-actions">
                <button
                  className="small-button"
                  disabled={blocked || !confirmed}
                  onClick={() =>
                    void run(
                      () =>
                        plan.kind === 'move'
                          ? invoke('trash_assets', {
                              ids: plan.items.map((i) => i.id),
                            })
                          : invoke('purge_trash', {
                              id: plan.items[0].id,
                              confirmed: true,
                            }),
                      plan.kind === 'move'
                        ? '已移入回收区，原有素材选择保持不变。'
                        : '已永久删除回收文件。',
                    )
                  }
                >
                  {plan.kind === 'move' ? '确认移入回收区' : '确认永久删除'}
                </button>
                <button
                  className="text-button"
                  disabled={working}
                  onClick={() => setPlan(null)}
                >
                  取消
                </button>
              </div>
            </fieldset>
          )}
          <details open>
            <summary>回收区 · {report.trash.length} 项</summary>
            <div className="storage-list">
              {report.trash.map((i) => (
                <article className="storage-row storage-trash-row" key={i.id}>
                  <span>
                    <strong>{i.name}</strong>
                    <small>
                      {kinds[i.kind]} · {size(i.bytes)}
                      {i.status !== 'trashed' && ' · 操作待完成'}
                    </small>
                  </span>
                  <button
                    className="small-button"
                    disabled={working || !!plan || i.status === 'purging'}
                    onClick={() =>
                      void run(
                        () => invoke('restore_trash', { id: i.id }),
                        '已恢复原素材与版本。',
                      )
                    }
                  >
                    恢复素材
                  </button>
                  <button
                    className="text-button"
                    disabled={
                      blocked ||
                      !!plan ||
                      !['trashed', 'purging'].includes(i.status)
                    }
                    onClick={() => preview('purge', [i])}
                  >
                    永久删除…
                  </button>
                </article>
              ))}
            </div>
            {!report.trash.length && <p className="field-hint">回收区为空。</p>}
          </details>
        </>
      )}
    </section>
  )
}
