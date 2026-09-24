import { useEffect, useRef, useState, type ReactNode } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from './api'
import * as api from './mediaApi'
import type { Shot, Workflow } from './model'
import type { useMedia } from './useMedia'
import { AssetImage } from './AssetImage'
import { CloudImageForm } from './CloudImageForm'
import './media.css'

export interface ShotTarget {
  nodeId: string
  shotId: string
}
interface Props {
  workflow: Workflow
  target: ShotTarget | null
  onTarget: (target: ShotTarget) => void
  media: ReturnType<typeof useMedia>
  busy: boolean
  save: (workflow: Workflow) => Promise<void>
  onFrameSelected: (context: api.ShotContext, versionId: string) => void
}
const jobLabels: Record<string, string> = {
  submitting: '提交中',
  saving: '保存中',
  waiting: '生成中',
  downloading: '保存中',
  succeeded: '已完成',
  paused: '待继续查询',
  unknown: '提交结果未知',
  failed: '失败',
}
const versionLabel = (id: string) => `${id.slice(0, 8)}…${id.slice(-2)}`

export function ImageStudio({
  workflow,
  target,
  onTarget,
  media,
  busy,
  save,
  onFrameSelected,
}: Props) {
  const shots = workflow.nodes.flatMap((n) =>
    n.kind === 'storyboard' && n.output && 'shots' in n.output.value
      ? n.output.value.shots.map((shot) => ({
          shot,
          node: n,
          artifactId: n.output!.id,
        }))
      : [],
  )
  const selected =
    shots.find(
      (s) => s.node.id === target?.nodeId && s.shot.id === target.shotId,
    ) ?? shots[0]
  const context: api.ShotContext | null = selected
    ? {
        workflowId: workflow.id,
        nodeId: selected.node.id,
        artifactId: selected.artifactId,
        shotId: selected.shot.id,
      }
    : null
  const frame = media.frames.find((f) => api.sameShot(f.context, context))
  const [pending, setPending] = useState<{
    asset: api.ImageAsset
    context: api.ShotContext
  } | null>(null)
  const [working, setWorking] = useState(false)
  const [filter, setFilter] = useState<'shot' | 'all'>('shot')
  const [generator, setGenerator] = useState<'cloud' | 'local'>('cloud')
  const [limit, setLimit] = useState(40)
  const fileInput = useRef<HTMLInputElement>(null)
  const library =
    filter === 'all'
      ? media.assets
      : media.assets.filter(
          (a) =>
            api.sameShot(a.context, context) ||
            a.versionId === frame?.versionId,
        )
  async function action(fn: () => Promise<unknown>) {
    setWorking(true)
    media.setError('')
    try {
      await fn()
      await media.refresh()
    } catch (e) {
      media.setError(errorMessage(e))
    } finally {
      setWorking(false)
    }
  }
  const canSelect =
    isDesktop && !busy && !working && !!selected && !selected.node.stale
  function propose(asset: api.ImageAsset) {
    if (canSelect && context) setPending({ asset, context })
  }
  return (
    <div className="image-studio">
      <div className="image-studio-top">
        <div>
          <p className="eyebrow">FRAME LAB / 镜头首帧</p>
          <h2>让分镜成为画面</h2>
          <p className="field-hint">
            生成候选、比较版本，选定一张再进入下一步。
          </p>
        </div>
        <button
          className="small-button"
          disabled={!isDesktop || working}
          onClick={() => fileInput.current?.click()}
        >
          ＋ 导入图片
        </button>
        <input
          ref={fileInput}
          aria-label="导入本地图片"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) {
              setFilter('all')
              void action(() => api.importImage(file))
            }
          }}
        />
      </div>
      {!isDesktop && (
        <p className="preview-strip">
          浏览器可预览首帧制作界面；云端或本机生图、保存图片请使用桌面应用。
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
              aria-label="首帧目标镜头"
              value={selected ? `${selected.node.id}/${selected.shot.id}` : ''}
              onChange={(e) => {
                const shot = shots.find(
                  (s) => `${s.node.id}/${s.shot.id}` === e.target.value,
                )
                if (shot)
                  onTarget({ nodeId: shot.node.id, shotId: shot.shot.id })
              }}
            >
              {!shots.length && <option value="">请先生成或录入分镜</option>}
              {shots.map((s) => (
                <option
                  key={`${s.node.id}/${s.shot.id}`}
                  value={`${s.node.id}/${s.shot.id}`}
                >
                  {s.node.label} · {s.shot.id} {s.shot.title}
                </option>
              ))}
            </select>
          </label>
          {selected && context ? (
            <>
              <div
                className="image-generator-switch"
                role="group"
                aria-label="生图方式"
              >
                <button
                  type="button"
                  className={`small-button ${generator === 'cloud' ? 'selected' : ''}`}
                  aria-pressed={generator === 'cloud'}
                  onClick={() => setGenerator('cloud')}
                >
                  云端生图
                </button>
                <button
                  type="button"
                  className={`small-button ${generator === 'local' ? 'selected' : ''}`}
                  aria-pressed={generator === 'local'}
                  onClick={() => setGenerator('local')}
                >
                  本机 ComfyUI
                </button>
              </div>
              {generator === 'cloud' ? (
                <CloudImageForm
                  key={`${workflow.id}/${context.artifactId}/${context.shotId}`}
                  context={context}
                  shot={selected.shot}
                  disabled={
                    busy || working || media.running || selected.node.stale
                  }
                  onStart={(request) =>
                    action(async () => {
                      await save(workflow)
                      await api.startCloudImageJob(request)
                    })
                  }
                  onError={media.setError}
                />
              ) : (
                <ImageForm
                  key={`${workflow.id}/${context.artifactId}/${context.shotId}`}
                  context={context}
                  shot={selected.shot}
                  disabled={
                    busy || working || media.running || selected.node.stale
                  }
                  onStart={(request) =>
                    action(async () => {
                      await save(workflow)
                      await api.startImageJob(request)
                    })
                  }
                  onError={media.setError}
                />
              )}
            </>
          ) : (
            <div className="media-empty">
              分镜就绪后，这里会自动带入镜头的生图提示词。也可以先导入图片到本地素材库。
            </div>
          )}
          {selected?.node.stale && (
            <p role="alert" className="workflow-error">
              上游内容已变化，请重新生成或确认分镜后再绑定首帧。
            </p>
          )}
        </aside>
        <div className="image-results">
          <div
            className="first-frame-target"
            onDragOver={(e) => {
              e.preventDefault()
              e.dataTransfer.dropEffect = canSelect ? 'copy' : 'none'
            }}
            onDrop={(e) => {
              e.preventDefault()
              const a = media.assets.find(
                (a) =>
                  a.versionId ===
                  e.dataTransfer.getData('application/frame-asset'),
              )
              if (a) propose(a)
            }}
          >
            {frame ? (
              <AssetImage versionId={frame.versionId} alt="已选镜头首帧" />
            ) : (
              <span className="first-frame-symbol">▧</span>
            )}
            <div>
              <strong>{frame ? '已选定镜头首帧' : '等待选择首帧'}</strong>
              <p>
                {frame
                  ? `版本 ${versionLabel(frame.versionId)} · 重新生成不会覆盖此选择`
                  : '点击候选图的选择按钮，或将素材拖到这里。'}
              </p>
              {selected?.node.stale && (
                <small>当前分镜已过期，此首帧仅作历史参考。</small>
              )}
            </div>
          </div>
          <div className="media-library-toolbar">
            <div>
              <button
                className={`small-button ${filter === 'shot' ? 'selected' : ''}`}
                onClick={() => setFilter('shot')}
              >
                当前镜头
              </button>
              <button
                className={`small-button ${filter === 'all' ? 'selected' : ''}`}
                onClick={() => setFilter('all')}
              >
                本地素材库
              </button>
            </div>
            <small>
              {library.length} 张{filter === 'all' ? ' · 最近 500 个版本' : ''}
            </small>
          </div>
          <div className="asset-grid">
            {library.slice(0, limit).map((a) => (
              <article
                className={`asset-card ${a.versionId === frame?.versionId ? 'is-selected' : ''}`}
                key={a.versionId}
                draggable={canSelect}
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/frame-asset', a.versionId)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
              >
                <AssetImage versionId={a.versionId} alt={a.name} />
                <div className="asset-card-info">
                  <strong title={a.name}>{a.name}</strong>
                  <small>
                    {a.width} × {a.height} ·{' '}
                    {a.source === 'import'
                      ? '导入'
                      : a.source === 'openai'
                        ? 'OpenAI'
                        : 'ComfyUI'}
                  </small>
                  <small>
                    版本 {versionLabel(a.versionId)} ·{' '}
                    {new Date(a.createdAt).toLocaleTimeString('zh-CN')}
                  </small>
                  <button
                    className="small-button"
                    disabled={!canSelect || a.versionId === frame?.versionId}
                    onClick={() => propose(a)}
                  >
                    {a.versionId === frame?.versionId
                      ? '✓ 当前首帧'
                      : '选为首帧'}
                  </button>
                </div>
              </article>
            ))}
          </div>
          {!library.length && (
            <div className="media-empty">
              <span>▧</span>
              <strong>
                {filter === 'shot'
                  ? '这个镜头还没有候选图'
                  : '你的本地图片素材库'}
              </strong>
              <p>
                {filter === 'shot'
                  ? '使用云端或本机模型生成图片，或切换到素材库选用已有画面。'
                  : '导入 PNG、JPEG、WebP，原图和缩略图会保存到本机。'}
              </p>
            </div>
          )}
          {library.length > limit && (
            <button
              className="small-button"
              onClick={() => setLimit((n) => n + 40)}
            >
              显示更多版本
            </button>
          )}
          <details className="image-job-history" open>
            <summary>云端图片任务记录 · {media.cloudJobs.length}</summary>
            {!media.cloudJobs.length && (
              <p className="field-hint">
                云端请求的模型、状态与候选版本会保存在这里。
              </p>
            )}
            {media.cloudJobs.map((job) => (
              <article key={job.id}>
                <div className="image-job-title">
                  <strong>{job.request.context.shotId}</strong>
                  <span
                    className={`badge ${job.status === 'failed' || job.status === 'unknown' ? 'danger' : ''}`}
                  >
                    {jobLabels[job.status] ?? job.status}
                  </span>
                  <time>{new Date(job.createdAt).toLocaleString('zh-CN')}</time>
                </div>
                <p>{job.message}</p>
                <details>
                  <summary>生成参数</summary>
                  <p>
                    模型：{job.request.model} · {job.request.size} ·{' '}
                    {job.request.quality}
                  </p>
                  <p>提示词：{job.request.positive}</p>
                  <p>避免元素：{job.request.negative || '无'}</p>
                </details>
              </article>
            ))}
          </details>
          <details className="image-job-history" open>
            <summary>ComfyUI 图片任务记录 · {media.jobs.length}</summary>
            {!media.jobs.length && (
              <p className="field-hint">
                这里会保留生成参数、任务 ID 和候选版本。
              </p>
            )}
            {media.jobs.map((job) => (
              <article key={job.id}>
                <div className="image-job-title">
                  <strong>{job.request.context.shotId}</strong>
                  <span
                    className={`badge ${job.status === 'failed' || job.status === 'unknown' ? 'danger' : ''}`}
                  >
                    {jobLabels[job.status] ?? job.status}
                  </span>
                  <time>{new Date(job.createdAt).toLocaleString('zh-CN')}</time>
                </div>
                <p>{job.message}</p>
                <details>
                  <summary>生成参数</summary>
                  <p>
                    模型：{job.request.checkpoint} · {job.request.width} ×{' '}
                    {job.request.height} · {job.request.count} 张 · Seed{' '}
                    {job.request.seed} · {job.request.steps} 步
                  </p>
                  <p>正面：{job.request.positive}</p>
                  <p>负面：{job.request.negative || '无'}</p>
                  <p>任务 ID：{job.promptId ?? '尚未收到'}</p>
                </details>
                {job.status === 'paused' && (
                  <button
                    className="small-button"
                    disabled={working || media.running}
                    onClick={() =>
                      void action(() => api.resumeImageJob(job.id))
                    }
                  >
                    继续查询原任务
                  </button>
                )}
                {api.isImageRunning(job) && (
                  <button
                    className="small-button"
                    disabled={working}
                    onClick={() => void action(() => api.pauseImageJob(job.id))}
                  >
                    停止等待
                  </button>
                )}
              </article>
            ))}
          </details>
        </div>
      </div>
      {pending && (
        <SelectionDialog onClose={() => setPending(null)}>
          <h3 id="frame-selection-title">确认镜头首帧</h3>
          <AssetImage
            versionId={pending.asset.versionId}
            alt={pending.asset.name}
          />
          <p>
            将「{pending.asset.name}」绑定到镜头 {pending.context.shotId}
            。之前的素材版本会继续保留。
          </p>
          <div className="form-actions">
            <button
              className="button secondary"
              autoFocus
              disabled={working}
              onClick={() => setPending(null)}
            >
              返回
            </button>
            <button
              className="button primary"
              disabled={
                working ||
                busy ||
                !api.sameShot(pending.context, context) ||
                !!selected?.node.stale
              }
              onClick={() =>
                void action(async () => {
                  await save(workflow)
                  await api.selectFirstFrame(
                    pending.context,
                    pending.asset.versionId,
                  )
                  onFrameSelected(pending.context, pending.asset.versionId)
                  setPending(null)
                })
              }
            >
              确认使用此版本
            </button>
          </div>
        </SelectionDialog>
      )}
    </div>
  )
}

function SelectionDialog({
  children,
  onClose,
}: {
  children: ReactNode
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    dialog?.showModal()
    return () => dialog?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      className="frame-selection-dialog"
      aria-labelledby="frame-selection-title"
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      {children}
    </dialog>
  )
}

function ImageForm({
  context,
  shot,
  disabled,
  onStart,
  onError,
}: {
  context: api.ShotContext
  shot: Shot
  disabled: boolean
  onStart: (request: api.ImageRequest) => Promise<void>
  onError: (message: string) => void
}) {
  const [request, setRequest] = useState<api.ImageRequest>(() => ({
    context,
    baseUrl: 'http://127.0.0.1:8188',
    checkpoint: '',
    positive: shot.imagePrompt,
    negative: 'blurry, low quality, watermark, text',
    width: 512,
    height: 768,
    steps: 20,
    seed: Math.floor(Math.random() * 1_000_000_000),
    count: 1,
  }))
  const [checkpoints, setCheckpoints] = useState<string[]>([])
  const [connection, setConnection] = useState('尚未检测连接')
  const [testing, setTesting] = useState(false)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let alive = true
    api
      .imageSettings()
      .then((saved) => {
        if (alive && saved)
          setRequest((r) => ({
            ...r,
            baseUrl: saved.baseUrl,
            checkpoint: saved.checkpoint,
            width: saved.width,
            height: saved.height,
            steps: saved.steps,
            count: saved.count,
            negative: saved.negative,
          }))
      })
      .catch((e) => {
        if (alive) onError(errorMessage(e))
      })
      .finally(() => {
        if (alive) setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [onError])
  function field<K extends keyof api.ImageRequest>(
    key: K,
    value: api.ImageRequest[K],
  ) {
    setRequest((r) => ({ ...r, [key]: value }))
  }
  async function test() {
    setTesting(true)
    setConnection('正在检测…')
    try {
      const names = await api.testComfy(request.baseUrl)
      setCheckpoints(names)
      setConnection(
        names.length
          ? `连接成功 · ${names.length} 个模型`
          : '服务已连接，但没有找到 Checkpoint 模型',
      )
      if (!names.includes(request.checkpoint))
        field('checkpoint', names[0] ?? '')
    } catch (e) {
      setCheckpoints([])
      setConnection(errorMessage(e))
    } finally {
      setTesting(false)
    }
  }
  return (
    <form
      className="image-form"
      onSubmit={(e) => {
        e.preventDefault()
        void onStart(request)
      }}
    >
      <fieldset disabled={!loaded || disabled || testing || !isDesktop}>
        <label className="field-label">
          ComfyUI 地址
          <input
            aria-label="ComfyUI 地址"
            type="url"
            required
            value={request.baseUrl}
            onChange={(e) => {
              field('baseUrl', e.target.value)
              setCheckpoints([])
              setConnection('地址已修改，请重新检测')
            }}
          />
        </label>
        <button
          type="button"
          className="small-button"
          onClick={() => void test()}
        >
          检测连接与模型
        </button>
        <p className="field-hint" role="status">
          {connection}
        </p>
        <label className="field-label">
          Checkpoint 模型
          <input
            list="comfy-checkpoints"
            aria-label="Checkpoint 模型"
            required
            maxLength={500}
            placeholder="选择或输入本机模型文件名"
            value={request.checkpoint}
            onChange={(e) => field('checkpoint', e.target.value)}
          />
          <datalist id="comfy-checkpoints">
            {checkpoints.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </label>
        <p className="field-hint">
          标准 SD 1.5 / SDXL 文生图流程。其他架构与自定义工作流将在后续接入。
        </p>
        <label className="field-label">
          正面提示词
          <textarea
            aria-label="生图正面提示词"
            required
            maxLength={16000}
            rows={5}
            value={request.positive}
            onChange={(e) => field('positive', e.target.value)}
          />
        </label>
        <button
          type="button"
          className="text-button"
          onClick={() => field('positive', shot.imagePrompt)}
        >
          重新带入分镜提示词
        </button>
        <label className="field-label">
          负面提示词
          <textarea
            aria-label="生图负面提示词"
            maxLength={16000}
            rows={2}
            value={request.negative}
            onChange={(e) => field('negative', e.target.value)}
          />
        </label>
        <div className="image-number-grid">
          {(
            [
              { key: 'width', label: '宽度', min: 256, max: 2048, step: 64 },
              { key: 'height', label: '高度', min: 256, max: 2048, step: 64 },
              { key: 'steps', label: '采样步数', min: 1, max: 60, step: 1 },
              { key: 'count', label: '候选数量', min: 1, max: 4, step: 1 },
            ] as const
          ).map((f) => (
            <label className="field-label" key={f.key}>
              {f.label}
              <input
                aria-label={f.label}
                type="number"
                required
                min={f.min}
                max={f.max}
                step={f.step}
                value={request[f.key]}
                onChange={(e) => field(f.key, Number(e.target.value))}
              />
            </label>
          ))}
        </div>
        <label className="field-label">
          随机种子 Seed
          <input
            aria-label="随机种子 Seed"
            type="number"
            required
            min={0}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            value={request.seed}
            onChange={(e) => field('seed', Number(e.target.value))}
          />
        </label>
        <button
          type="button"
          className="text-button"
          onClick={() =>
            field('seed', Math.floor(Math.random() * 1_000_000_000))
          }
        >
          换一个种子
        </button>
        <button className="button primary generate-image-button" type="submit">
          生成 {request.count} 张候选图
        </button>
        <p className="field-hint">
          使用本机算力。相同参数与种子通常得到相同画面；探索新版本时可换种子。停止等待不会中断
          ComfyUI。
        </p>
      </fieldset>
    </form>
  )
}
