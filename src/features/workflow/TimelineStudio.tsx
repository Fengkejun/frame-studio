import { useEffect, useMemo, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from './api'
import * as api from './mediaApi'
import { AssetImage } from './AssetImage'
import { AudioPreview } from './AudioPreview'
import { ExportPreview } from './ExportPreview'
import { AudioAlignment } from './AudioAlignment'
import { TimelineEffectsPanel } from './TimelineEffectsPanel'
import {
  defaultEffects,
  timelineLayout,
  audioFadeError,
} from './timelineTiming'
import { SubtitleStudio } from './SubtitleStudio'
import { VoiceoverStudio } from './VoiceoverStudio'
import { ShotVoiceAlignment } from './ShotVoiceAlignment'
import {
  storyboardRanks,
  storyboardOrder,
  voiceCueError,
} from './timelineReview'
import type { Workflow } from './model'
import type { useMedia } from './useMedia'
import './media.css'

function initialDraft(workflowId: string): api.Composition {
  return {
    workflowId,
    clips: [],
    aspect: '9:16',
    resolution: 720,
    quality: 'balanced',
    musicVersionId: null,
    voiceVersionId: null,
    voiceStartMs: 0,
    effects: { ...defaultEffects },
    musicVolume: 35,
    subtitleVersionId: null,
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
  const [subtitles, setSubtitles] = useState<api.SubtitleAsset[]>([])
  const [audio, setAudio] = useState<api.AudioAsset[]>([])
  const [jobs, setJobs] = useState<api.ExportJob[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [exportPreview, setExportPreview] = useState<api.ExportJob | null>(null)
  const ranks = useMemo(
    () => storyboardRanks(workflow, media.videoAssets),
    [workflow, media.videoAssets],
  )
  const candidates = useMemo(
    () =>
      media.selectedVideos
        .flatMap((selection) => {
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
        })
        .sort(
          (a, b) =>
            (ranks.get(a.asset.versionId) ?? Infinity) -
            (ranks.get(b.asset.versionId) ?? Infinity),
        ),
    [
      media.selectedVideos,
      media.videoAssets,
      media.frames,
      workflow.nodes,
      ranks,
    ],
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
  const boundSubtitle = subtitles.find(
    (item) => item.versionId === draft.subtitleVersionId,
  )
  const staleSubtitles =
    !!draft.subtitleVersionId &&
    (!boundSubtitle ||
      boundSubtitle.sourceAudioVersionId !== draft.voiceVersionId)
  const active = jobs.find((job) => job.status === 'running')
  const layout = timelineLayout(draft)
  const totalMs = layout.totalMs
  const fadeError = audioFadeError(
    draft,
    totalMs,
    audio.find((item) => item.versionId === draft.voiceVersionId)?.durationMs,
  )
  const invalidVoiceStart =
    !!draft.voiceVersionId && draft.voiceStartMs >= totalMs
  const cueError = voiceCueError(
    draft,
    audio.find((a) => a.versionId === draft.voiceVersionId)?.durationMs,
  )
  const sortedClips = storyboardOrder(draft.clips, ranks)
  const orderChanged = sortedClips.some(
    (c, i) => c.versionId !== draft.clips[i]?.versionId,
  )
  const targetRatio =
    draft.aspect === '9:16' ? 9 / 16 : draft.aspect === '1:1' ? 1 : 16 / 9
  const firstMetadata = media.videoAssets.find(
    (a) => a.versionId === draft.clips[0]?.versionId,
  )?.metadata
  const suggestedAspect = firstMetadata
    ? firstMetadata.width === firstMetadata.height
      ? '1:1'
      : firstMetadata.width > firstMetadata.height
        ? '16:9'
        : '9:16'
    : draft.aspect
  const letterboxed = draft.clips.flatMap((c) => {
    const asset = media.videoAssets.find((a) => a.versionId === c.versionId)
    const m = asset?.metadata
    if (!m) return []
    const ratio = m.width / m.height
    const visible = Math.min(ratio / targetRatio, targetRatio / ratio)
    return visible < 0.75
      ? [{ shot: asset.context.shotId, visible: Math.round(visible * 100) }]
      : []
  })
  const voiceDuration = audio.find(
    (a) => a.versionId === draft.voiceVersionId,
  )?.durationMs
  const quietTail =
    draft.voiceVersionId &&
    !draft.musicVersionId &&
    !draft.voiceCues?.length &&
    voiceDuration !== undefined
      ? Math.max(0, totalMs - draft.voiceStartMs - voiceDuration)
      : 0
  const missing = draft.clips.some(
    (clip) =>
      !candidates.some(({ asset }) => asset.versionId === clip.versionId),
  )
  const invalidClip = draft.clips.some((clip) => {
    const duration = media.videoAssets.find(
      (asset) => asset.versionId === clip.versionId,
    )?.metadata?.durationMs
    return (
      !Number.isInteger(clip.trimStartMs) ||
      !Number.isInteger(clip.trimEndMs) ||
      clip.trimStartMs < 0 ||
      clip.trimEndMs <= clip.trimStartMs ||
      clip.trimEndMs - clip.trimStartMs > 60000 ||
      (duration !== undefined && clip.trimEndMs > duration + 50)
    )
  })
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
  if (!loaded)
    return (
      <div className="timeline-studio">
        <h2>成片合成</h2>
        {error ? (
          <p className="workflow-error" role="alert">
            {error}
          </p>
        ) : (
          <p role="status">正在加载时间线…</p>
        )}
      </div>
    )
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
                          trimEndMs: Math.min(
                            60000,
                            asset.metadata?.durationMs ?? asset.duration * 1000,
                          ),
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
        {!!candidates.length && (
          <button
            className="small-button"
            onClick={() =>
              setDraft((value) => ({
                ...value,
                clips: candidates.map(
                  ({ asset, shot }) =>
                    value.clips.find(
                      (c) => c.versionId === asset.versionId,
                    ) ?? {
                      versionId: asset.versionId,
                      trimStartMs: 0,
                      trimEndMs: Math.min(
                        60000,
                        asset.metadata?.durationMs ?? asset.duration * 1000,
                        (shot?.duration ?? 60) * 1000,
                      ),
                      caption: shot?.dialogue ?? '',
                    },
                ),
                voiceCues: (value.voiceCues ?? []).filter((c) =>
                  candidates.some((v) => v.asset.versionId === c.clipVersionId),
                ),
              }))
            }
          >
            按分镜装配全部已选镜头
          </button>
        )}
      </section>
      <section className="timeline-section">
        <h3>镜头顺序与裁剪</h3>
        {orderChanged && (
          <p className="workflow-error">
            当前镜头顺序与分镜不同，请确认是有意调整。
            <button
              className="small-button"
              onClick={() =>
                setDraft((value) => ({
                  ...value,
                  clips: storyboardOrder(value.clips, ranks),
                }))
              }
            >
              恢复分镜顺序
            </button>
          </p>
        )}
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
                      max={
                        asset?.metadata
                          ? asset.metadata.durationMs / 1000
                          : 3600
                      }
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
                      max={
                        asset?.metadata
                          ? asset.metadata.durationMs / 1000
                          : 3600
                      }
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
                        voiceCues: (value.voiceCues ?? []).filter(
                          (c) => c.clipVersionId !== clip.versionId,
                        ),
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
            画面适配
            <select
              aria-label="画面适配"
              value={draft.fit ?? 'contain'}
              onChange={(e) =>
                setDraft((value) => ({
                  ...value,
                  fit: e.target.value as api.Composition['fit'],
                }))
              }
            >
              <option value="contain">保留完整画面（留黑边）</option>
              <option value="cover">铺满画面（居中裁切）</option>
              <option value="blur">保留完整画面 + 模糊背景</option>
            </select>
            <small>
              横屏素材建议优先横屏导出。裁切可能切掉人物或道具；模糊背景只填补空白，不补画面内容。
            </small>
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
            导出质量
            <select
              aria-label="导出质量"
              value={draft.quality}
              disabled={!isDesktop || busy || !!active || !loaded}
              onChange={(event) =>
                setDraft((value) => ({
                  ...value,
                  quality: event.target.value as api.Composition['quality'],
                }))
              }
            >
              <option value="compact">体积优先</option>
              <option value="balanced">均衡（推荐）</option>
              <option value="high">高画质</option>
            </select>
            <span className="field-hint">
              {draft.quality === 'compact'
                ? '更小的文件，适合快速分享。实际体积取决于画面内容。'
                : draft.quality === 'high'
                  ? '保留更多细节，编码耗时与文件体积通常更高。'
                  : '兼顾画质、编码速度与文件体积。'}
            </span>
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
                  voiceCues: [],
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
      <section
        className="timeline-section timeline-preflight"
        aria-label="成片审片检查"
      >
        <h3>成片审片检查</h3>
        <p className="field-hint">
          导出前按顺序播放相邻镜头，核对人物外观、天气、道具和动作。程序检查尺寸与时间关系，视觉一致性仍需人工确认；镜头原声当前不参与导出混音。
        </p>
        <div className="timeline-review-strip">
          {draft.clips.map((clip, i) => {
            const asset = media.videoAssets.find(
              (a) => a.versionId === clip.versionId,
            )
            return (
              <article key={clip.versionId}>
                <strong>
                  {i + 1} · {asset?.context.shotId ?? '失效镜头'}
                </strong>
                <small>
                  {(layout.startsMs[i]! / 1000).toFixed(2)} 秒起 ·{' '}
                  {asset?.metadata
                    ? `${asset.metadata.width}×${asset.metadata.height}`
                    : '尺寸待核实'}
                </small>
                <AssetImage
                  versionId={asset?.firstFrameVersionId ?? ''}
                  alt={`审片 ${i + 1} 首帧`}
                />
                <p>{clip.caption || '无台词'}</p>
                <button
                  className="small-button"
                  onClick={() =>
                    void api
                      .videoPreview(clip.versionId)
                      .then(setPreview)
                      .catch((e) => setError(errorMessage(e)))
                  }
                >
                  审看镜头 {i + 1}
                </button>
              </article>
            )
          })}
        </div>
        {!!letterboxed.length && (
          <p role="status">
            {letterboxed
              .map((v) => `${v.shot} 主画面约占画布 ${v.visible}%`)
              .join('；')}
            。
            {(draft.fit ?? 'contain') === 'contain'
              ? '当前会出现明显黑边。'
              : draft.fit === 'cover'
                ? '当前会裁掉部分内容，请检查主体。'
                : '当前使用模糊背景补齐。'}
            <button
              className="small-button"
              onClick={() =>
                setDraft((value) => ({
                  ...value,
                  aspect: suggestedAspect,
                }))
              }
            >
              按首镜头方向调整画幅
            </button>
          </p>
        )}
        {quietTail > 1000 && (
          <p role="status">
            末尾约 {(quietTail / 1000).toFixed(1)}{' '}
            秒没有外加配音或音乐。请核对分句对齐，或导入合适的背景音乐。
          </p>
        )}
        {draft.voiceVersionId &&
          !draft.voiceCues?.length &&
          draft.subtitleFormat === 'none' &&
          draft.clips.some((c) => c.caption) && (
            <p role="status">
              当前片段字幕按整镜头显示，尚未与配音逐句对齐。可在下方按镜头对齐配音与字幕。
            </p>
          )}
      </section>
      <ShotVoiceAlignment
        draft={draft}
        voice={audio.find((a) => a.versionId === draft.voiceVersionId)}
        busy={busy || !!active || !loaded}
        onChange={setDraft}
      />
      {!draft.voiceCues?.length ? (
        <>
          <AudioAlignment
            key={`audio-alignment-${workflow.id}`}
            voice={audio.find(
              (item) => item.versionId === draft.voiceVersionId,
            )}
            music={audio.find(
              (item) => item.versionId === draft.musicVersionId,
            )}
            clips={draft.clips}
            layout={layout}
            effects={draft.effects}
            voiceStartMs={draft.voiceStartMs}
            musicVolume={draft.musicVolume}
            busy={busy || !!active || !loaded}
            onOffset={(voiceStartMs) =>
              setDraft((value) => ({ ...value, voiceStartMs }))
            }
          />
        </>
      ) : (
        <p className="field-hint">
          已启用分镜配音；各句跟随对应镜头，整体配音偏移与波形操作暂停。修改转场或裁剪后会重新检查每句时长。
        </p>
      )}
      <TimelineEffectsPanel
        effects={draft.effects}
        totalMs={totalMs}
        clipCount={draft.clips.length}
        invalidTransition={layout.invalid}
        fadeError={fadeError}
        hasVoice={!!draft.voiceVersionId && !draft.voiceCues?.length}
        hasMusic={!!draft.musicVersionId}
        busy={busy || !!active || !loaded}
        onChange={(patch) =>
          setDraft((value) => ({
            ...value,
            effects: { ...value.effects, ...patch },
          }))
        }
      />
      {invalidVoiceStart && (
        <p className="workflow-error" role="alert">
          配音起点须早于成片结束时间；请调整起点或延长时间线。
        </p>
      )}
      {draft.voiceVersionId && (
        <div className="timeline-section">
          <strong>原始配音试听（未加入时间线延迟）</strong>
          <AudioPreview
            key={draft.voiceVersionId}
            versionId={draft.voiceVersionId}
          />
        </div>
      )}
      <VoiceoverStudio
        key={workflow.id}
        workflow={workflow}
        save={save}
        assets={audio}
        setAssets={setAudio}
        selectedId={draft.voiceVersionId}
        onUse={(versionId) =>
          setDraft((value) => ({
            ...value,
            voiceVersionId: versionId,
            voiceCues: [],
          }))
        }
        captions={draft.clips
          .map((clip) => clip.caption)
          .filter(Boolean)
          .join('\n')}
      />
      {!draft.voiceCues?.length && (
        <SubtitleStudio
          key={`subtitles-${workflow.id}`}
          workflow={workflow}
          save={save}
          voice={audio.find((item) => item.versionId === draft.voiceVersionId)}
          voiceStartMs={draft.voiceStartMs}
          timelineDurationMs={totalMs}
          audio={audio}
          assets={subtitles}
          setAssets={setSubtitles}
          appliedId={draft.subtitleVersionId}
          onApply={(asset, srt) =>
            setDraft((value) => ({
              ...value,
              subtitleVersionId: asset.versionId,
              subtitleFormat: 'srt',
              subtitleText: srt,
            }))
          }
        />
      )}
      {staleSubtitles && (
        <p className="workflow-error" role="alert">
          已应用字幕与当前配音不匹配；请应用匹配的字幕，或改用片段字幕后再导出。
        </p>
      )}
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
            disabled={!!draft.voiceCues?.length}
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
                        subtitleVersionId: null,
                      })),
                    )
                    .catch((reason) => setError(errorMessage(reason)))
              }
              event.target.value = ''
            }}
          />
        </label>
        {!!draft.voiceCues?.length && (
          <p className="field-hint">
            分镜配音使用逐句台词字幕。要导入字幕或使用转写字幕，请先点击“恢复整段配音”，以免改变已确认的音画对齐。
          </p>
        )}
        {draft.subtitleFormat !== 'none' && (
          <div>
            <p className="field-hint">
              {draft.subtitleVersionId
                ? `已应用自动字幕版本 ${draft.subtitleVersionId.slice(0, 8)}`
                : `已导入 ${draft.subtitleFormat.toUpperCase()} 字幕`}
            </p>
            <button
              className="text-button"
              onClick={() =>
                setDraft((value) => ({
                  ...value,
                  subtitleFormat: 'none',
                  subtitleText: '',
                  subtitleVersionId: null,
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
            staleSubtitles ||
            invalidVoiceStart ||
            layout.invalid ||
            !!fadeError ||
            invalidClip ||
            !!cueError
          }
          onClick={() => void exportVideo()}
        >
          选择位置并导出 MP4
        </button>
        {missing && (
          <p className="workflow-error">时间线中有失效的视频版本，请替换。</p>
        )}
        {cueError && (
          <p className="workflow-error" role="alert">
            {cueError}
          </p>
        )}
        {invalidClip && (
          <p className="workflow-error" role="alert">
            裁剪须在素材时长内，结束晚于开始，单段长度不超过 60 秒。
          </p>
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
            <small>
              {job.draft.aspect} · {job.draft.resolution}p ·
              {job.draft.quality === 'high'
                ? ' 高画质'
                : job.draft.quality === 'compact'
                  ? ' 体积优先'
                  : ' 均衡'}
            </small>
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
            {job.status === 'succeeded' && (
              <button
                className="small-button"
                disabled={!isDesktop}
                onClick={() => setExportPreview(job)}
              >
                播放成片
              </button>
            )}
            {exportPreview?.id === job.id && (
              <ExportPreview
                key={job.id}
                job={job}
                onClose={() => setExportPreview(null)}
              />
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
