import { useEffect, useRef, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from './api'
import * as api from './mediaApi'

export interface BatchTarget {
  context: api.ShotContext
  prompt: string
  label: string
}
export function BatchSubmit({
  targets,
  request,
  disabled,
  onStart,
}: {
  targets: BatchTarget[]
  request: api.BatchRequest
  disabled: boolean
  onStart: (requests: api.BatchRequest[]) => Promise<void>
}) {
  const [selected, setSelected] = useState<string[]>([])
  const key = (target: BatchTarget) =>
    `${target.context.nodeId}/${target.context.artifactId}/${target.context.shotId}`
  const chosen = targets.filter((t) => selected.includes(key(t)))
  return (
    <details className="batch-submit">
      <summary>批量生成镜头候选</summary>
      <p className="field-hint">
        勾选 1–24
        个镜头，逐个生成。每个镜头使用自己的分镜提示词，其余参数沿用上方设置；候选保存后仍需手动选择首帧。
      </p>
      <button
        type="button"
        className="text-button"
        disabled={disabled}
        onClick={() => setSelected(targets.slice(0, 24).map(key))}
      >
        选择全部镜头
      </button>
      <div className="batch-targets">
        {targets.map((t) => (
          <label key={key(t)}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={selected.includes(key(t))}
              onChange={(e) =>
                setSelected((v) =>
                  e.target.checked
                    ? [...v, key(t)]
                    : v.filter((k) => k !== key(t)),
                )
              }
            />
            {t.label}
          </label>
        ))}
      </div>
      <p className="field-hint">
        已选 {chosen.length} 个镜头
        {request.kind === 'cloud'
          ? ` · 合计预算预留 ${api.formatUsd(chosen.length * request.request.budgetReservationMicroUsd)}；请求可能计费，实际费用以服务商账单为准。`
          : ' · 使用本机算力。'}
      </p>
      <button
        type="button"
        className="small-button"
        disabled={
          !isDesktop || disabled || !chosen.length || chosen.length > 24
        }
        onClick={() =>
          void onStart(
            chosen.map((t) =>
              request.kind === 'cloud'
                ? {
                    kind: 'cloud',
                    request: {
                      ...request.request,
                      context: t.context,
                      positive: t.prompt,
                    },
                  }
                : {
                    kind: 'comfy',
                    request: {
                      ...request.request,
                      context: t.context,
                      positive: t.prompt,
                    },
                  },
            ),
          )
        }
      >
        提交批量图片队列
      </button>
    </details>
  )
}
const labels: Record<string, string> = {
  running: '运行中',
  queued: '等待提交',
  paused: '已暂停',
  succeeded: '已完成',
  failed: '失败',
  unknown: '结果未知',
  skipped: '已跳过',
}
export function ImageBatchHistory({
  workflowId,
  revision,
  onError,
  onRefresh,
}: {
  workflowId: string
  revision: number
  onError: (error: string) => void
  onRefresh: () => Promise<void>
}) {
  const [batches, setBatches] = useState<api.ImageBatch[]>([])
  const [busy, setBusy] = useState(false)
  const last = useRef('')
  useEffect(() => {
    let alive = true
    const refresh = () =>
      void api
        .listImageBatches(workflowId)
        .then((v) => {
          if (alive) {
            setBatches(v)
            const signature = JSON.stringify(v)
            if (signature !== last.current) {
              last.current = signature
              void onRefresh().catch((e) => onError(errorMessage(e)))
            }
          }
        })
        .catch((e) => {
          if (alive) onError(errorMessage(e))
        })
    refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [workflowId, revision, onError, onRefresh])
  async function run(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
      setBatches(await api.listImageBatches(workflowId))
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="image-batch-history" aria-label="图片批量队列">
      <h3>图片批量队列</h3>
      {!batches.length && (
        <p className="field-hint">在生成表单中勾选多个镜头，提交批量候选。</p>
      )}
      {batches.map((batch) => (
        <article className="image-batch" key={batch.id}>
          <strong>
            {labels[batch.status]} ·{' '}
            {batch.items.filter((i) => i.status === 'succeeded').length}/
            {batch.items.length} 个镜头完成
          </strong>
          <p className="field-hint">
            暂停只阻止后续提交，当前请求继续；应用重启后须手动继续队列。
          </p>
          <button
            className="small-button"
            disabled={busy || !isDesktop || batch.status !== 'running'}
            onClick={() => void run(() => api.pauseImageBatch(batch.id))}
          >
            暂停队列
          </button>
          <button
            className="small-button"
            disabled={
              busy ||
              !isDesktop ||
              batch.status !== 'paused' ||
              batch.items.some((i) => i.status === 'unknown')
            }
            onClick={() => void run(() => api.resumeImageBatch(batch.id))}
          >
            继续队列
          </button>
          <ol>
            {batch.items.map((item, index) => (
              <li key={`${index}/${item.jobId}`}>
                <strong>
                  {item.request.request.context.shotId} · {labels[item.status]}
                </strong>
                <p>{item.message}</p>
                {item.status === 'failed' && (
                  <button
                    className="small-button"
                    disabled={busy || batch.status === 'running'}
                    onClick={() =>
                      void run(() => api.retryImageBatchItem(batch.id, index))
                    }
                  >
                    重排失败项（可能计费）
                  </button>
                )}
                {item.status === 'unknown' && (
                  <button
                    className="small-button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api.skipUnknownImageBatchItem(batch.id, index),
                      )
                    }
                  >
                    已核对，跳过未知项
                  </button>
                )}
              </li>
            ))}
          </ol>
        </article>
      ))}
    </section>
  )
}
