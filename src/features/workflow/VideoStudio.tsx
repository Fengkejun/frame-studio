import { useEffect, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from './api'
import * as api from './mediaApi'
import type { Shot, Workflow } from './model'
import type { useMedia } from './useMedia'
import { AssetImage } from './AssetImage'
import type { ShotTarget } from './ImageStudio'
import './media.css'

interface Props {
  workflow: Workflow
  target: ShotTarget | null
  onTarget: (target: ShotTarget) => void
  media: ReturnType<typeof useMedia>
  busy: boolean
  save: (workflow: Workflow) => Promise<void>
  onClipSelected: (context: api.ShotContext, versionId: string) => void
  onImages: () => void
}
const statusLabel: Record<string, string> = {
  submitting: '提交中',
  queued: '排队中',
  running: '生成中',
  downloading: '下载中',
  succeeded: '已保存',
  paused: '待继续查询',
  unknown: '结果未知',
  failed: '失败',
}
export function VideoStudio({
  workflow,
  target,
  onTarget,
  media,
  busy,
  save,
  onClipSelected,
  onImages,
}: Props) {
  const shots = workflow.nodes.flatMap((node) =>
    node.kind === 'storyboard' && node.output && 'shots' in node.output.value
      ? node.output.value.shots.map((shot) => ({
          shot,
          node,
          artifactId: node.output!.id,
        }))
      : [],
  )
  const selected =
    shots.find(
      (item) =>
        item.node.id === target?.nodeId && item.shot.id === target.shotId,
    ) ?? shots[0]
  const context: api.ShotContext | null = selected
    ? {
        workflowId: workflow.id,
        nodeId: selected.node.id,
        artifactId: selected.artifactId,
        shotId: selected.shot.id,
      }
    : null
  const firstFrame = media.frames.find((frame) =>
    api.sameShot(frame.context, context),
  )
  const image = media.assets.find(
    (asset) => asset.versionId === firstFrame?.versionId,
  )
  const chosen = media.selectedVideos.find((item) =>
    api.sameShot(item.context, context),
  )
  const candidates = media.videoAssets.filter((item) =>
    api.sameShot(item.context, context),
  )
  const shotRunning = media.videoJobs.some(
    (job) =>
      api.sameShot(job.request.context, context) && api.isVideoRunning(job),
  )
  const [working, setWorking] = useState(false)
  const [preview, setPreview] = useState<{
    versionId: string
    data: string
  } | null>(null)
  async function action(fn: () => Promise<unknown>) {
    setWorking(true)
    media.setError('')
    try {
      await fn()
      await media.refresh()
    } catch (error) {
      media.setError(errorMessage(error))
    } finally {
      setWorking(false)
    }
  }
  const ready =
    !!context &&
    !!firstFrame &&
    !!image &&
    image.width >= 240 &&
    image.height >= 240 &&
    image.width <= 8000 &&
    image.height <= 8000 &&
    image.width <= image.height * 8 &&
    image.height <= image.width * 8 &&
    !selected?.node.stale
  return (
    <div className="image-studio video-studio">
      <div className="image-studio-top">
        <div>
          <p className="eyebrow">FRAME LAB / 镜头视频</p>
          <h2>从首帧生成镜头片段</h2>
          <p className="field-hint">每个镜头独立提交、查询、保存和选择版本。</p>
        </div>
      </div>
      {!isDesktop && (
        <p className="preview-strip">
          浏览器可预览视频工作台；真实任务请使用桌面应用。
        </p>
      )}
      {media.error && (
        <div className="workflow-error" role="alert">
          {media.error}
          <button className="text-button" onClick={() => media.setError('')}>
            关闭
          </button>
        </div>
      )}
      <div className="image-studio-layout">
        <aside className="image-settings">
          <label className="field-label">
            目标镜头
            <select
              aria-label="视频目标镜头"
              value={selected ? `${selected.node.id}/${selected.shot.id}` : ''}
              onChange={(event) => {
                const item = shots.find(
                  (shot) =>
                    `${shot.node.id}/${shot.shot.id}` === event.target.value,
                )
                if (item)
                  onTarget({ nodeId: item.node.id, shotId: item.shot.id })
              }}
            >
              {!shots.length && <option value="">请先生成分镜</option>}
              {shots.map((item) => (
                <option
                  key={`${item.node.id}/${item.shot.id}`}
                  value={`${item.node.id}/${item.shot.id}`}
                >
                  {item.node.label} · {item.shot.id} {item.shot.title}
                </option>
              ))}
            </select>
          </label>
          {firstFrame ? (
            <div className="video-source">
              <AssetImage versionId={firstFrame.versionId} alt="视频首帧" />
              <div>
                <strong>已确认首帧</strong>
                <small>版本 {firstFrame.versionId}</small>
              </div>
            </div>
          ) : (
            <p className="field-hint">这个镜头尚未选择首帧。</p>
          )}
          {!ready && (
            <p className="workflow-error" role="alert">
              {image && !selected?.node.stale
                ? '首帧宽高需在 240–8000 像素，宽高比在 1:8–8:1。'
                : '先在首帧工作台确认当前分镜版本的图片。'}
              <button className="small-button" onClick={onImages}>
                打开首帧工作台
              </button>
            </p>
          )}
          {selected && context && firstFrame && (
            <VideoForm
              key={`${context.artifactId}/${context.shotId}/${firstFrame.versionId}`}
              context={context}
              firstFrameVersionId={firstFrame.versionId}
              shot={selected.shot}
              disabled={!ready || busy || working || shotRunning}
              onStart={(request) =>
                action(async () => {
                  await save(workflow)
                  await api.startVideoJob(request)
                })
              }
              onError={media.setError}
            />
          )}
        </aside>
        <div className="image-results">
          <section className="video-candidates">
            <h3>镜头候选 · {candidates.length}</h3>
            {chosen && (
              <p className="field-hint">
                已选片段版本 {chosen.versionId}。重新生成不会替换已选版本。
              </p>
            )}
            {!candidates.length && (
              <div className="media-empty">
                完成图生视频后，片段会保存在本机并出现在这里。
              </div>
            )}
            <div className="asset-grid">
              {candidates.map((asset) => (
                <article
                  className={`asset-card ${chosen?.versionId === asset.versionId ? 'is-selected' : ''}`}
                  key={asset.versionId}
                >
                  <AssetImage
                    versionId={asset.firstFrameVersionId}
                    alt={`${asset.context.shotId} 首帧`}
                  />
                  <div className="asset-card-info">
                    <strong>
                      {asset.context.shotId} · {asset.duration} 秒
                    </strong>
                    <small>
                      {asset.resolution} ·{' '}
                      {(asset.bytes / 1024 / 1024).toFixed(1)} MB
                    </small>
                    <small>
                      版本 {asset.versionId.slice(0, 8)} ·{' '}
                      {new Date(asset.createdAt).toLocaleString('zh-CN')}
                    </small>
                    {asset.firstFrameVersionId !== firstFrame?.versionId && (
                      <small>源首帧已变化，请用当前首帧重新生成。</small>
                    )}
                    <button
                      className="small-button"
                      disabled={working}
                      onClick={() =>
                        void action(async () => {
                          const data = await api.videoPreview(asset.versionId)
                          setPreview({ versionId: asset.versionId, data })
                        })
                      }
                    >
                      播放片段
                    </button>
                    <button
                      className="small-button"
                      disabled={
                        working ||
                        busy ||
                        chosen?.versionId === asset.versionId ||
                        asset.firstFrameVersionId !== firstFrame?.versionId
                      }
                      onClick={() =>
                        void action(async () => {
                          await save(workflow)
                          await api.selectVideo(asset.context, asset.versionId)
                          onClipSelected(asset.context, asset.versionId)
                        })
                      }
                    >
                      {chosen?.versionId === asset.versionId
                        ? '✓ 当前片段'
                        : '选为镜头片段'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
            {preview && (
              <div className="video-player">
                <div>
                  <strong>片段预览 · {preview.versionId.slice(0, 8)}</strong>
                  <button
                    className="text-button"
                    onClick={() => setPreview(null)}
                  >
                    关闭预览
                  </button>
                </div>
                <video
                  controls
                  playsInline
                  src={preview.data}
                  aria-label="镜头视频预览"
                />
              </div>
            )}
          </section>
          <details className="image-job-history" open>
            <summary>图生视频任务记录 · {media.videoJobs.length}</summary>
            {media.videoJobs.map((job) => (
              <article key={job.id}>
                <div className="image-job-title">
                  <strong>{job.request.context.shotId}</strong>
                  <span
                    className={`badge ${['failed', 'unknown'].includes(job.status) ? 'danger' : ''}`}
                  >
                    {statusLabel[job.status] ?? job.status}
                  </span>
                  <time>{new Date(job.createdAt).toLocaleString('zh-CN')}</time>
                </div>
                <p>{job.message}</p>
                <small>
                  远程任务 ID：{job.taskId ?? '未取得'} · 首帧版本：
                  {job.request.firstFrameVersionId.slice(0, 8)}
                </small>
                <details>
                  <summary>生成参数</summary>
                  <p>
                    {job.request.region} · {job.request.resolution} ·{' '}
                    {job.request.duration} 秒
                  </p>
                  <p>提示词：{job.request.prompt}</p>
                </details>
                {job.status === 'paused' && job.taskId && (
                  <button
                    className="small-button"
                    disabled={working}
                    onClick={() =>
                      void action(() => api.resumeVideoJob(job.id))
                    }
                  >
                    继续查询原任务
                  </button>
                )}
                {api.isVideoRunning(job) && (
                  <button
                    className="small-button"
                    disabled={working}
                    onClick={() => void action(() => api.pauseVideoJob(job.id))}
                  >
                    停止本地查询
                  </button>
                )}
              </article>
            ))}
          </details>
        </div>
      </div>
    </div>
  )
}

function VideoForm({
  context,
  firstFrameVersionId,
  shot,
  disabled,
  onStart,
  onError,
}: {
  context: api.ShotContext
  firstFrameVersionId: string
  shot: Shot
  disabled: boolean
  onStart: (request: api.VideoRequest) => Promise<void>
  onError: (message: string) => void
}) {
  const [request, setRequest] = useState<api.VideoRequest>({
    context,
    firstFrameVersionId,
    region: 'singapore',
    prompt: shot.videoPrompt,
    negativePrompt: '',
    duration: Math.min(15, Math.max(2, Math.round(shot.duration))),
    resolution: '720P',
  })
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [checking, setChecking] = useState(true)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    let alive = true
    api
      .videoKeyStatus(request.region)
      .then((result) => {
        if (alive) setHasKey(result)
      })
      .catch((error) => {
        if (alive) onError(errorMessage(error))
      })
      .finally(() => {
        if (alive) setChecking(false)
      })
    return () => {
      alive = false
    }
  }, [request.region, onError])
  return (
    <form
      className="image-form"
      onSubmit={(event) => {
        event.preventDefault()
        void onStart(request)
      }}
    >
      <fieldset disabled={!isDesktop || checking || disabled || saving}>
        <p className="field-hint">
          万相 Wan 2.7 图生视频。任务按秒计费，提交前请核对地区、时长与分辨率。
        </p>
        <label className="field-label">
          服务地区
          <select
            aria-label="视频服务地区"
            value={request.region}
            onChange={(event) => {
              setChecking(true)
              setHasKey(false)
              setRequest((value) => ({
                ...value,
                region: event.target.value as api.VideoRequest['region'],
              }))
            }}
          >
            <option value="singapore">新加坡</option>
            <option value="beijing">北京</option>
          </select>
        </label>
        <label className="field-label">
          万相 API Key
          <input
            aria-label="万相 API Key"
            type="password"
            autoComplete="off"
            value={key}
            placeholder={
              hasKey ? '已保存在系统凭据库' : '输入当前地区的 API Key'
            }
            onChange={(event) => setKey(event.target.value)}
          />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="small-button"
            disabled={!key.trim()}
            onClick={() => {
              setSaving(true)
              void api
                .saveVideoKey(request.region, key)
                .then(() => {
                  setKey('')
                  setHasKey(true)
                })
                .catch((error) => onError(errorMessage(error)))
                .finally(() => setSaving(false))
            }}
          >
            保存密钥
          </button>
          {hasKey && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setSaving(true)
                void api
                  .clearVideoKey(request.region)
                  .then(() => setHasKey(false))
                  .catch((error) => onError(errorMessage(error)))
                  .finally(() => setSaving(false))
              }}
            >
              移除密钥
            </button>
          )}
        </div>
        <p className="field-hint" role="status">
          {hasKey
            ? '当前地区密钥已保存在系统凭据库。'
            : '请先保存当前地区的 API Key。'}
        </p>
        <label className="field-label">
          视频提示词
          <textarea
            aria-label="视频提示词"
            required
            maxLength={5000}
            rows={5}
            value={request.prompt}
            onChange={(event) =>
              setRequest((value) => ({ ...value, prompt: event.target.value }))
            }
          />
        </label>
        <button
          type="button"
          className="text-button"
          onClick={() =>
            setRequest((value) => ({ ...value, prompt: shot.videoPrompt }))
          }
        >
          重新带入分镜视频提示词
        </button>
        <label className="field-label">
          避免出现的元素
          <textarea
            aria-label="视频负面提示词"
            maxLength={500}
            rows={2}
            value={request.negativePrompt}
            onChange={(event) =>
              setRequest((value) => ({
                ...value,
                negativePrompt: event.target.value,
              }))
            }
          />
        </label>
        <div className="image-number-grid">
          <label className="field-label">
            时长 / 秒
            <input
              aria-label="视频时长"
              type="number"
              required
              min={2}
              max={15}
              step={1}
              value={request.duration}
              onChange={(event) =>
                setRequest((value) => ({
                  ...value,
                  duration: Number(event.target.value),
                }))
              }
            />
          </label>
          <label className="field-label">
            分辨率
            <select
              aria-label="视频分辨率"
              value={request.resolution}
              onChange={(event) =>
                setRequest((value) => ({
                  ...value,
                  resolution: event.target
                    .value as api.VideoRequest['resolution'],
                }))
              }
            >
              <option value="720P">720P</option>
              <option value="1080P">1080P</option>
            </select>
          </label>
        </div>
        <button
          type="submit"
          className="button primary generate-image-button"
          disabled={!hasKey}
        >
          提交图生视频任务
        </button>
        <p className="field-hint">
          停止只结束本地查询，不会取消远程生成。拿到任务 ID
          后可继续查询；提交结果未知时请先核对服务商用量。
        </p>
      </fieldset>
    </form>
  )
}
