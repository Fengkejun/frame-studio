import { useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from './api'
import * as api from './mediaApi'
import { ImageBatchHistory, type BatchTarget } from './ImageBatch'
import type { Workflow } from './model'
import type { useMedia } from './useMedia'
import { AssetImage } from './AssetImage'
import type { ShotTarget } from './ImageStudio'
import './media.css'
import { productionPrompt } from './production'
import { SequenceStudio } from './SequenceStudio'
import { VideoForm } from './VideoForm'

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
  const chosen = media.selectedVideos.find(
    (item) =>
      api.sameShot(item.context, context) &&
      media.videoAssets.some(
        (a) => a.versionId === item.versionId && !a.sequence,
      ),
  )
  const candidates = media.videoAssets.filter(
    (item) => api.sameShot(item.context, context) && !item.sequence,
  )
  const shotRunning = media.videoJobs.some(
    (job) =>
      api.sameShot(job.request.context, context) && api.isVideoRunning(job),
  )
  const [working, setWorking] = useState(false)
  const [creationMode, setCreationMode] = useState<'sequence' | 'clips'>(() =>
    workflow.production && shots.length > 1 ? 'sequence' : 'clips',
  )
  const [batchRevision, setBatchRevision] = useState(0)
  const batchTargets: BatchTarget[] = shots.flatMap(
    ({ node, artifactId, shot }) => {
      const context = {
        workflowId: workflow.id,
        nodeId: node.id,
        artifactId,
        shotId: shot.id,
      }
      const frame = media.frames.find((f) => api.sameShot(f.context, context))
      const asset = media.assets.find((a) => a.versionId === frame?.versionId)
      if (node.stale || !frame || !asset || !validVideoFrame(asset)) return []
      return [
        {
          context,
          prompt: productionPrompt(workflow, shot.videoPrompt),
          label: `${node.label} · ${shot.id} ${shot.title}`,
          video: {
            firstFrameVersionId: frame.versionId,
            duration: Math.round(shot.duration),
          },
        },
      ]
    },
  )
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
    validVideoFrame(image) &&
    !selected?.node.stale
  const modeSwitch = (
    <div className="form-actions" role="group" aria-label="视频制作方式">
      <button
        className="small-button"
        aria-pressed={creationMode === 'sequence'}
        onClick={() => setCreationMode('sequence')}
      >
        整段分镜生成
      </button>
      <button
        className="small-button"
        aria-pressed={creationMode === 'clips'}
        onClick={() => setCreationMode('clips')}
      >
        逐镜头制作
      </button>
    </div>
  )
  if (creationMode === 'sequence')
    return (
      <div className="image-studio video-studio">
        {modeSwitch}
        {media.error && (
          <p className="workflow-error" role="alert">
            {media.error}
          </p>
        )}
        <SequenceStudio
          workflow={workflow}
          media={media}
          save={save}
          busy={busy}
        />
      </div>
    )
  return (
    <div className="image-studio video-studio">
      {modeSwitch}
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
          <button
            className="small-button"
            disabled={
              !isDesktop ||
              working ||
              busy ||
              !context ||
              !firstFrame ||
              !!selected?.node.stale
            }
            onClick={() =>
              void action(async () => {
                if (!context || !firstFrame) return
                await save(workflow)
                await api.importVideo(context, firstFrame.versionId)
              })
            }
          >
            {working ? '处理中…' : '导入本地视频'}
          </button>
          <p className="field-hint">
            支持 H.264 MP4，最大 2 GB、1
            小时。导入后关联当前镜头与首帧，再播放并选择片段版本。
            原片声音可在预览中播放；成片音轨使用时间线选择的配音和音乐。
          </p>
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
              key={`${context.artifactId}/${context.shotId}/${firstFrame.versionId}/${JSON.stringify(workflow.production)}`}
              context={context}
              firstFrameVersionId={firstFrame.versionId}
              shot={{
                ...selected.shot,
                videoPrompt: productionPrompt(
                  workflow,
                  selected.shot.videoPrompt,
                ),
              }}
              disabled={!ready || busy || working || shotRunning}
              batchTargets={batchTargets}
              onBatch={(requests) =>
                action(async () => {
                  await save(workflow)
                  await api.startVideoBatch(
                    requests.map((r) => {
                      if (r.kind !== 'video') throw new Error('请选择视频任务')
                      return r.request
                    }),
                  )
                  setBatchRevision((v) => v + 1)
                })
              }
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
          <ImageBatchHistory
            kind="video"
            workflowId={workflow.id}
            revision={batchRevision}
            onError={media.setError}
            onRefresh={media.refresh}
          />
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
                    <small>
                      {asset.source === 'import'
                        ? `本地导入 · ${asset.name ?? 'MP4 视频'}`
                        : '云端生成'}
                    </small>
                    <strong>
                      {asset.context.shotId} ·{' '}
                      {(asset.metadata
                        ? asset.metadata.durationMs / 1000
                        : asset.duration
                      ).toFixed(2)}{' '}
                      秒
                    </strong>
                    <small>
                      {asset.metadata
                        ? `${asset.metadata.width} × ${asset.metadata.height} · ${asset.metadata.fps.toFixed(2)} fps`
                        : `${asset.resolution}（提交参数）`}{' '}
                      · {(asset.bytes / 1024 / 1024).toFixed(1)} MB
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
                  onError={() =>
                    media.setError('片段播放失败，请检查视频编码或文件完整性。')
                  }
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
                {job.estimatedCostMicroUsd > 0 && (
                  <small>
                    {job.request.wulusai
                      ? '提交时预算预留：'
                      : '提交时标价预估：'}
                    {api.formatUsd(job.estimatedCostMicroUsd)}
                  </small>
                )}
                <small>
                  远程任务 ID：{job.taskId ?? '未取得'} · 首帧版本：
                  {job.request.firstFrameVersionId.slice(0, 8)}
                </small>
                <details>
                  <summary>生成参数</summary>
                  <p>
                    {job.request.wulusai
                      ? `视频中转站 · ${job.request.wulusai.model}`
                      : job.request.region}{' '}
                    · {job.request.resolution} · {job.request.duration} 秒
                  </p>
                  <p>提示词：{job.request.prompt}</p>
                </details>
                {(job.status === 'paused' ||
                  (job.status === 'unknown' && job.request.wulusai)) &&
                  job.taskId && (
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

function validVideoFrame(image: { width: number; height: number }) {
  return (
    image.width >= 240 &&
    image.height >= 240 &&
    image.width <= 8000 &&
    image.height <= 8000 &&
    image.width <= image.height * 8 &&
    image.height <= image.width * 8
  )
}
