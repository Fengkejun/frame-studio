import type { Workflow } from './model'
import type { useMedia } from './useMedia'
import * as api from './mediaApi'
import { VideoForm } from './VideoForm'
import { sequencePrompt } from './sequencePlan'
import { useState } from 'react'
import { errorMessage } from './api'
import { isDesktop } from '@/shared/lib/desktop'

const jobLabels: Record<string, string> = {
  submitting: '提交中',
  queued: '排队中',
  running: '生成中',
  downloading: '下载中',
  saving: '保存中',
  succeeded: '已保存',
  paused: '查询已暂停',
  unknown: '结果待核实',
  failed: '生成失败',
  cancelled: '本地已停止',
}

export function SequenceStudio({
  workflow,
  media,
  save,
  busy,
}: {
  workflow: Workflow
  media: ReturnType<typeof useMedia>
  save: (w: Workflow) => Promise<void>
  busy: boolean
}) {
  const boards = workflow.nodes.filter(
    (n) =>
      n.kind === 'storyboard' &&
      !n.stale &&
      n.output &&
      'shots' in n.output.value,
  )
  const [boardId, setBoardId] = useState('')
  const board = boards.find((n) => n.id === boardId) ?? boards[0]
  const shots =
    board?.output && 'shots' in board.output.value
      ? board.output.value.shots
      : []
  const [working, setWorking] = useState(false)
  const [preview, setPreview] = useState('')
  const [savedCopy, setSavedCopy] = useState('')
  const context =
    board?.output && shots[0]
      ? {
          workflowId: workflow.id,
          nodeId: board.id,
          artifactId: board.output.id,
          shotId: shots[0].id,
        }
      : null
  const frame = media.frames.find((f) => api.sameShot(f.context, context))
  const duration = shots.reduce((sum, s) => sum + s.duration, 0)
  const jobs = media.videoJobs.filter(
    (j) =>
      !!j.request.sequence &&
      j.request.context.nodeId === board?.id &&
      j.request.context.artifactId === board.output?.id,
  )
  const candidates = media.videoAssets.filter(
    (a) =>
      !!a.sequence &&
      a.context.nodeId === board?.id &&
      a.context.artifactId === board.output?.id,
  )
  const active = jobs.some(api.isVideoRunning)
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
  return (
    <section className="sequence-studio">
      <h2>整段分镜生成</h2>
      <p className="field-hint">
        把整组分镜编排为一条带时间段的提示词，只提交一次视频生成。文生模式无需分别生成首帧；图生模式使用第一镜头的一张已确认首帧。
      </p>
      <p className="field-hint">
        当前已接入模型单次最多 15
        秒。时间分镜是模型提示，不是严格剪辑指令；一致性和镜头切换仍需审片。更长作品需要另行适配服务商的延展接口。
      </p>
      <label className="field-label">
        分镜来源
        <select
          aria-label="整段分镜来源"
          value={board?.id ?? ''}
          disabled={working || active}
          onChange={(e) => setBoardId(e.target.value)}
        >
          {boards.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label}
            </option>
          ))}
        </select>
      </label>
      {context && shots[0] ? (
        <>
          <p>
            共 {shots.length} 个分镜 · 总时长 {duration} 秒 · 一次提交
          </p>
          <VideoForm
            key={`${context.artifactId}/${frame?.versionId ?? 'text'}/${JSON.stringify(workflow.production)}`}
            context={context}
            firstFrameVersionId={frame?.versionId ?? ''}
            sequence={{ shotIds: shots.map((s) => s.id) }}
            shot={{
              ...shots[0],
              duration,
              videoPrompt: sequencePrompt(workflow, shots),
            }}
            disabled={busy || working || active}
            batchTargets={[]}
            onBatch={async () => {
              throw new Error('整段模式不拆成批量任务')
            }}
            onError={media.setError}
            onStart={(request) =>
              action(async () => {
                await save(workflow)
                await api.startVideoJob(request)
              })
            }
          />
        </>
      ) : (
        <p>请先生成或录入分镜。</p>
      )}
      <h3>整段视频版本</h3>
      {candidates.map((a) => (
        <article className="speech-job" key={a.versionId}>
          <strong>
            整段 {a.sequence!.shotIds.length} 分镜 ·{' '}
            {(a.metadata ? a.metadata.durationMs / 1000 : a.duration).toFixed(
              2,
            )}{' '}
            秒
          </strong>
          <small>{a.sequence!.shotIds.join(' → ')}</small>
          <button
            className="small-button"
            onClick={() =>
              void action(async () =>
                setPreview(await api.videoPreview(a.versionId)),
              )
            }
          >
            播放整段视频
          </button>
          <button
            className="small-button"
            disabled={
              !isDesktop ||
              working ||
              media.selectedVideos.some((v) => v.versionId === a.versionId)
            }
            onClick={() =>
              void action(async () => {
                await api.selectVideo(a.context, a.versionId)
              })
            }
          >
            选为整段版本
          </button>
          <button
            className="small-button"
            disabled={!isDesktop || working}
            onClick={() =>
              void action(async () => {
                const outputPath = await api.chooseExportPath()
                if (!outputPath) return
                await api.saveVideoCopy(a.versionId, outputPath)
                setSavedCopy(outputPath)
              })
            }
          >
            保存原始 MP4（含原声）
          </button>
          <p className="field-hint">
            选定后，时间线只装配这条整段视频，避免又加入其覆盖的各个短镜头。旧素材与导出记录保留。
          </p>
        </article>
      ))}
      {preview && (
        <video
          className="sequence-player"
          controls
          aria-label="整段视频预览"
          src={preview}
        />
      )}
      <p className="field-hint">
        保存原件会直接复制视频及模型原声，不重新生成、不转码。时间线导出使用另行设置的配音与音乐。
      </p>
      {savedCopy && <p role="status">已保存：{savedCopy}</p>}
      <h3>整段任务记录</h3>
      {jobs.map((j) => (
        <article className="speech-job" key={j.id}>
          <strong>
            {jobLabels[j.status] ?? j.status} · {j.request.duration} 秒 ·{' '}
            {j.request.sequence!.shotIds.length} 个分镜
          </strong>
          <p>{j.message}</p>
          {j.taskId && <small>远程任务：{j.taskId}</small>}
          {api.isVideoRunning(j) && (
            <button
              className="small-button"
              disabled={working}
              onClick={() => void action(() => api.pauseVideoJob(j.id))}
            >
              停止本地查询
            </button>
          )}
          {j.taskId && ['paused', 'unknown'].includes(j.status) && (
            <button
              className="small-button"
              disabled={working}
              onClick={() => void action(() => api.resumeVideoJob(j.id))}
            >
              查询原任务
            </button>
          )}
        </article>
      ))}
    </section>
  )
}
