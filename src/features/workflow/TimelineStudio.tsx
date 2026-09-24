import { useEffect, useMemo, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from './api'
import * as api from './mediaApi'
import { AssetImage } from './AssetImage'
import type { Workflow } from './model'
import type { useMedia } from './useMedia'
import './media.css'

function initialDraft(workflowId: string): api.Composition {
  return {
    workflowId,
    clips: [],
    aspect: '9:16',
    resolution: 720,
    musicVersionId: null,
    voiceVersionId: null,
    musicVolume: 35,
    subtitleFormat: 'none',
    subtitleText: '',
  }
}

export function TimelineStudio({
  workflow,
  media,
  save,
  onVideos,
}: {
  workflow: Workflow
  media: ReturnType<typeof useMedia>
  save: (workflow: Workflow) => Promise<void>
  onVideos: () => void
}) {
  const [draft, setDraft] = useState<api.Composition>(() =>
    initialDraft(workflow.id),
  )
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [audio, setAudio] = useState<api.AudioAsset[]>([])
  const [jobs, setJobs] = useState<api.ExportJob[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const candidates = useMemo(
    () =>
      media.selectedVideos.flatMap((selection) => {
        const asset = media.videoAssets.find(
          (item) => item.versionId === selection.versionId,
        )
        const frame = media.frames.find((item) =>
          api.sameShot(item.context, selection.context),
        )
        const storyboard = workflow.nodes.find(
          (node) => node.id === selection.context.nodeId,
        )
        const shot =
          storyboard?.output?.value && 'shots' in storyboard.output.value
            ? storyboard.output.value.shots.find(
                (item) => item.id === selection.context.shotId,
              )
            : undefined
        return asset &&
          frame?.versionId === asset.firstFrameVersionId &&
          storyboard?.output?.id === selection.context.artifactId &&
          !storyboard.stale
          ? [{ asset, shot }]
          : []
      }),
    [media.selectedVideos, media.videoAssets, media.frames, workflow.nodes],
  )
  useEffect(() => {
    let alive = true
    void Promise.all([
      api.getComposition(workflow.id),
      api.listAudioAssets(workflow.id),
      api.listExportJobs(workflow.id),
    ])
      .then(([saved, assets, exports]) => {
        if (!alive) return
        setDraft(saved ?? initialDraft(workflow.id))
        setAudio(assets)
        setJobs(exports)
        setLoaded(true)
      })
      .catch((reason) => setError(errorMessage(reason)))
    return () => {
      alive = false
    }
  }, [workflow.id])
  useEffect(() => {
    if (!loaded || !isDesktop) return
    const timer = window.setTimeout(() => {
      setSaving(true)
      void save(workflow)
        .then(() => api.saveComposition(draft))
        .catch((reason) => setError(errorMessage(reason)))
        .finally(() => setSaving(false))
    }, 500)
    return () => window.clearTimeout(timer)
  }, [draft, loaded, workflow, save])
  useEffect(() => {
    if (!jobs.some((job) => job.status === 'running')) return
    const timer = window.setInterval(() => {
      void api
        .listExportJobs(workflow.id)
        .then(setJobs)
        .catch((reason) => setError(errorMessage(reason)))
    }, 700)
    return () => window.clearInterval(timer)
  }, [jobs, workflow.id])
  const active = jobs.find((job) => job.status === 'running')
  const totalMs = draft.clips.reduce(
    (sum, clip) => sum + clip.trimEndMs - clip.trimStartMs,
    0,
  )
  const missing = draft.clips.some(
    (clip) =>
      !candidates.some(({ asset }) => asset.versionId === clip.versionId),
  )
  function patchClip(index: number, patch: Partial<api.TimelineClip>) {
    setDraft((value) => ({
      ...value,
      clips: value.clips.map((clip, i) =>
        i === index ? { ...clip, ...patch } : clip,
      ),
    }))
  }
  function move(index: number, offset: number) {
    setDraft((value) => {
      const clips = [...value.clips]
      const [clip] = clips.splice(index, 1)
      clips.splice(index + offset, 0, clip!)
      return { ...value, clips }
    })
  }
  async function exportVideo() {
    setError('')
    setBusy(true)
    try {
      await save(workflow)
      await api.saveComposition(draft)
      const outputPath = await api.chooseExportPath()
      if (!outputPath) return
      const job = await api.startExport(draft, outputPath)
      setJobs((values) => [job, ...values])
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  async function addAudio(file: File) {
    setError('')
    setBusy(true)
    try {
      const asset = await api.importAudio(workflow.id, file)
      setAudio((values) => [asset, ...values])
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="timeline-studio">
      <div className="image-studio-top">
        <div>
          <p className="eyebrow">FRAME LAB / 时间线</p>
          <h2>成片合成</h2>
          <p className="field-hint">
            排列镜头、裁剪长度、加入字幕与声音，导出 MP4。
          </p>
        </div>
        <strong>{(totalMs / 1000).toFixed(1)} 秒</strong>
      </div>
      {!isDesktop && (
        <p className="preview-strip">浏览器仅展示时间线；桌面应用执行导出。</p>
      )}
      {error && (
        <p className="workflow-error" role="alert">
          {error}{' '}
          <button className="text-button" onClick={() => setError('')}>
            关闭
          </button>
        </p>
      )}
      <section className="timeline-section">
        <div className="timeline-heading">
          <h3>已确认的视频片段</h3>
          <button className="small-button" onClick={onVideos}>
            打开镜头视频
          </button>
        </div>
        {!candidates.length && (
          <p className="media-empty">请先在镜头视频中选择片段版本。</p>
        )}
        <div className="timeline-candidates">
          {candidates.map(({ asset, shot }) => (
            <article key={asset.versionId} className="timeline-choice">
              <AssetImage
                versionId={asset.firstFrameVersionId}
                alt={`${asset.context.shotId} 首帧`}
              />
              <div>
                <strong>{shot?.title ?? asset.context.shotId}</strong>
                <small>版本 {asset.versionId.slice(0, 8)}</small>
                <button
                  className="small-button"
                  disabled={draft.clips.some(
                    (clip) => clip.versionId === asset.versionId,
                  )}
                  onClick={() =>
                    setDraft((value) => ({
                      ...value,
                      clips: [
                        ...value.clips,
                        {
                          versionId: asset.versionId,
                          trimStartMs: 0,
                          trimEndMs: asset.duration * 1000,
                          caption: shot?.dialogue ?? '',
                        },
                      ],
                    }))
                  }
                >
                  添加到时间线
                </button>
                <button
                  className="text-button"
                  onClick={() =>
                    void api
                      .videoPreview(asset.versionId)
                      .then(setPreview)
                      .catch((reason) => setError(errorMessage(reason)))
                  }
                >
                  播放片段
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="timeline-section">
        <h3>镜头顺序与裁剪</h3>
        {!draft.clips.length && (
          <p className="media-empty">从上方添加片段，再调整顺序和长度。</p>
        )}
        <div className="timeline-clips">
          {draft.clips.map((clip, index) => {
            const asset = media.videoAssets.find(
              (item) => item.versionId === clip.versionId,
            )
            const current = candidates.some(
              (item) => item.asset.versionId === clip.versionId,
            )
            return (
              <article key={clip.versionId} className="timeline-clip">
                <div className="timeline-clip-head">
                  <span>{index + 1}</span>
                  <AssetImage
                    versionId={asset?.firstFrameVersionId ?? ''}
                    alt={`${asset?.context.shotId ?? '失效'} 首帧`}
                  />
                  <div>
                    <strong>{asset?.context.shotId ?? '原片段已丢失'}</strong>
                    <small>版本 {clip.versionId.slice(0, 8)}</small>
                    {!current && <small>选择或首帧已变化，请更换片段。</small>}
                  </div>
                </div>
                <div className="timeline-fields">
                  <label className="field-label">
                    开始 / 秒
                    <input
                      aria-label={`片段 ${index + 1} 开始`}
                      type="number"
                      min={0}
                      max={60}
                      step={0.1}
                      value={clip.trimStartMs / 1000}
                      onChange={(event) =>
                        patchClip(index, {
                          trimStartMs: Math.round(
                            Number(event.target.value) * 1000,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="field-label">
                    结束 / 秒
                    <input
                      aria-label={`片段 ${index + 1} 结束`}
                      type="number"
                      min={0.1}
                      max={60}
                      step={0.1}
                      value={clip.trimEndMs / 1000}
                      onChange={(event) =>
                        patchClip(index, {
                          trimEndMs: Math.round(
                            Number(event.target.value) * 1000,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="field-label timeline-caption">
                    片段字幕
                    <input
                      aria-label={`片段 ${index + 1} 字幕`}
                      maxLength={500}
                      value={clip.caption}
                      onChange={(event) =>
                        patchClip(index, { caption: event.target.value })
                      }
                    />
                  </label>
                </div>
                <div className="timeline-actions">
                  <button
                    className="small-button"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    左移
                  </button>
                  <button
                    className="small-button"
                    disabled={index === draft.clips.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    右移
                  </button>
                  <button
                    className="text-button"
                    onClick={() =>
                      setDraft((value) => ({
                        ...value,
                        clips: value.clips.filter((_, i) => i !== index),
                      }))
                    }
                  >
                    移除
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      </section>
      <section className="timeline-section timeline-settings">
        <h3>画面与声音</h3>
        <div className="timeline-fields">
          <label className="field-label">
            画幅
            <select
              aria-label="导出画幅"
              value={draft.aspect}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  aspect: event.target.value as api.Composition['aspect'],
                }))
              }
            >
              <option value="9:16">9:16 竖屏</option>
              <option value="16:9">16:9 横屏</option>
              <option value="1:1">1:1 方形</option>
            </select>
          </label>
          <label className="field-label">
            分辨率
            <select
              aria-label="导出分辨率"
              value={draft.resolution}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  resolution: Number(event.target.value) as 720 | 1080,
                }))
              }
            >
              <option value={720}>720p</option>
              <option value={1080}>1080p</option>
            </select>
          </label>
          <label className="field-label">
            导入配音或音乐
            <input
              type="file"
              aria-label="导入音频"
              accept=".mp3,.wav,.m4a,.aac,.flac,.ogg"
              disabled={!isDesktop || busy}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void addAudio(file)
                event.target.value = ''
              }}
            />
          </label>
          <label className="field-label">
            背景音乐
            <select
              aria-label="背景音乐"
              value={draft.musicVersionId ?? ''}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  musicVersionId: event.target.value || null,
                }))
              }
            >
              <option value="">无</option>
              {audio.map((item) => (
                <option key={item.versionId} value={item.versionId}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            配音
            <select
              aria-label="配音"
              value={draft.voiceVersionId ?? ''}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  voiceVersionId: event.target.value || null,
                }))
              }
            >
              <option value="">无</option>
              {audio.map((item) => (
                <option key={item.versionId} value={item.versionId}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            音乐音量 {draft.musicVolume}%
            <input
              aria-label="音乐音量"
              type="range"
              min={0}
              max={100}
              value={draft.musicVolume}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  musicVolume: Number(event.target.value),
                }))
              }
            />
          </label>
        </div>
      </section>
      <section className="timeline-section timeline-settings">
        <h3>字幕</h3>
        <p className="field-hint">
          不导入文件时，片段字幕按当前顺序生成；导入 SRT 或 VTT 后使用文件内容。
        </p>
        <label className="field-label">
          导入字幕文件
          <input
            type="file"
            aria-label="导入字幕文件"
            accept=".srt,.vtt"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) {
                if (file.size > 100_000) setError('字幕文件不能超过 100 KB')
                else
                  void file
                    .text()
                    .then((text) =>
                      setDraft((value) => ({
                        ...value,
                        subtitleFormat: file.name.toLowerCase().endsWith('.vtt')
                          ? 'vtt'
                          : 'srt',
                        subtitleText: text,
                      })),
                    )
                    .catch((reason) => setError(errorMessage(reason)))
              }
              event.target.value = ''
            }}
          />
        </label>
        {draft.subtitleFormat !== 'none' && (
          <div>
            <p className="field-hint">
              已导入 {draft.subtitleFormat.toUpperCase()} 字幕
            </p>
            <button
              className="text-button"
              onClick={() =>
                setDraft((value) => ({
                  ...value,
                  subtitleFormat: 'none',
                  subtitleText: '',
                }))
              }
            >
              改用片段字幕
            </button>
          </div>
        )}
      </section>
      <section className="timeline-section">
        <button
          className="button primary"
          disabled={
            !isDesktop ||
            !loaded ||
            busy ||
            saving ||
            !!active ||
            !draft.clips.length ||
            missing ||
            draft.clips.some((clip) => clip.trimEndMs <= clip.trimStartMs)
          }
          onClick={() => void exportVideo()}
        >
          选择位置并导出 MP4
        </button>
        {missing && (
          <p className="workflow-error">时间线中有失效的视频版本，请替换。</p>
        )}
        {saving && <p className="field-hint">正在保存时间线…</p>}
      </section>
      <section className="timeline-section">
        <h3>导出记录</h3>
        {!jobs.length && <p className="media-empty">还没有导出记录。</p>}
        {jobs.map((job) => (
          <article key={job.id} className="timeline-export">
            <div>
              <strong>
                {job.status === 'succeeded'
                  ? '已完成'
                  : job.status === 'running'
                    ? `导出中 ${job.progress}%`
                    : job.status === 'interrupted'
                      ? '已中断'
                      : '导出失败'}
              </strong>
              <small>{new Date(job.createdAt).toLocaleString('zh-CN')}</small>
            </div>
            <p>{job.message}</p>
            <small className="timeline-path">{job.outputPath}</small>
            {job.coverPath && (
              <small className="timeline-path">封面：{job.coverPath}</small>
            )}
            {job.status === 'running' && (
              <button
                className="small-button"
                onClick={() =>
                  void api
                    .cancelExport(job.id)
                    .catch((reason) => setError(errorMessage(reason)))
                }
              >
                停止导出
              </button>
            )}
          </article>
        ))}
      </section>
      {preview && (
        <div className="video-player">
          <button className="text-button" onClick={() => setPreview(null)}>
            关闭预览
          </button>
          <video controls src={preview} />
        </div>
      )}
    </div>
  )
}
