import { useEffect, useRef, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from './api'
import * as api from './mediaApi'

export interface BatchTarget {
  context: api.ShotContext
  prompt: string
  label: string
  video?: { firstFrameVersionId: string; duration: number }
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
  const chosen = targets.filter(
    (t) => selected.includes(key(t)) && (request.kind !== 'video' || t.video),
  )
  const video = request.kind === 'video'
  const requests: api.BatchRequest[] = chosen.map((t) => {
    if (request.kind === 'video' && t.video)
      return {
        kind: 'video',
        request: api.normalizeVideoRequest({
          ...request.request,
          context: t.context,
          firstFrameVersionId: t.video.firstFrameVersionId,
          duration: t.video.duration,
          prompt: t.prompt,
        }),
      }
    if (request.kind === 'cloud')
      return {
        kind: 'cloud',
        request: { ...request.request, context: t.context, positive: t.prompt },
      }
    if (request.kind === 'comfy')
      return {
        kind: 'comfy',
        request: { ...request.request, context: t.context, positive: t.prompt },
      }
    throw new Error('视频镜头缺少已确认首帧')
  })
  return (
    <details className="batch-submit">
      <summary>{video ? '批量生成视频候选' : '批量生成镜头候选'}</summary>
      <p className="field-hint">
        {video
          ? '勾选 1–24 个已确认有效首帧的镜头，逐个生成。首帧、视频提示词和时长使用各自分镜（时长取整并限制在当前模型支持的范围），视频服务、生成方式、分辨率、预算预留和负面提示词沿用上方设置。候选保存后仍需手动选择片段。已有视频任务时队列等待。'
          : '勾选 1–24 个镜头，逐个生成。每个镜头使用自己的分镜提示词，其余参数沿用上方设置；候选保存后仍需手动选择首帧。'}
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
          : request.kind === 'video'
            ? ` · 合计${request.request.wulusai ? '预算预留' : '标价预估'} ${api.formatUsd(requests.reduce((sum, r) => sum + (r.kind === 'video' ? api.videoEstimateMicroUsd(r.request.region, r.request.resolution, r.request.duration, r.request.wulusai) : 0), 0))}；实际费用以服务商账单为准。`
            : ' · 使用本机算力。'}
      </p>
      <button
        type="button"
        className="small-button"
        disabled={
          !isDesktop || disabled || !chosen.length || chosen.length > 24
        }
        onClick={() => void onStart(requests)}
      >
        {video ? '提交批量视频队列' : '提交批量图片队列'}
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
function filterBatches(batches: api.ImageBatch[], kind: 'image' | 'video') {
  return batches.filter(
    (b) => (b.items[0]?.request.kind === 'video') === (kind === 'video'),
  )
}
export function ImageBatchHistory({
  kind = 'image',
  workflowId,
  revision,
  onError,
  onRefresh,
}: {
  kind?: 'image' | 'video'
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
            const filtered = filterBatches(v, kind)
            setBatches(filtered)
            const signature = JSON.stringify(filtered)
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
  }, [workflowId, revision, onError, onRefresh, kind])
  async function run(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
      setBatches(filterBatches(await api.listImageBatches(workflowId), kind))
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="image-batch-history"
      aria-label={kind === 'video' ? '视频批量队列' : '图片批量队列'}
    >
      <h3>{kind === 'video' ? '视频批量队列' : '图片批量队列'}</h3>
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
