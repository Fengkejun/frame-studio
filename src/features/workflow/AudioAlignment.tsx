import { useEffect, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from './api'
import { getAudioWaveform } from './mediaApi'
import type {
  AudioAsset,
  AudioWaveform,
  TimelineClip,
  TimelineEffects,
} from './mediaApi'
import type { timelineLayout } from './timelineTiming'

// Immutable versions can share a small in-memory cache across both tracks.
const cache = new Map<string, Promise<AudioWaveform>>()
function waveform(versionId: string) {
  let result = cache.get(versionId)
  if (!result) {
    result = getAudioWaveform(versionId).catch((reason: unknown) => {
      cache.delete(versionId)
      throw reason
    })
    if (cache.size >= 12) cache.delete(cache.keys().next().value!)
    cache.set(versionId, result)
  }
  return result
}

function WaveformTrack({
  asset,
  label,
  totalMs,
  offsetMs,
  loop,
  volume,
  fadeInMs,
  fadeOutMs,
}: {
  asset: AudioAsset
  label: string
  totalMs: number
  offsetMs: number
  loop: boolean
  volume: number
  fadeInMs: number
  fadeOutMs: number
}) {
  const [data, setData] = useState<AudioWaveform | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!isDesktop) return
    let alive = true
    void waveform(asset.versionId).then(
      (value) => {
        if (alive) setData(value)
      },
      (reason: unknown) => {
        if (alive) setError(errorMessage(reason))
      },
    )
    return () => {
      alive = false
    }
  }, [asset.versionId, attempt])
  const span = Math.max(totalMs, 1)
  const bars = data
    ? Array.from({ length: 512 }, (_, i) => {
        const time = (i * span) / 512 - offsetMs
        const inTrack = time >= 0 && (loop || time < data.durationMs)
        const sourceTime = loop ? time % data.durationMs : time
        const audibleMs = Math.max(
          0,
          Math.min(loop ? totalMs : data.durationMs, totalMs - offsetMs),
        )
        const gain = Math.max(
          0,
          Math.min(
            1,
            fadeInMs ? time / fadeInMs : 1,
            fadeOutMs ? (audibleMs - time) / fadeOutMs : 1,
          ),
        )
        const peak = inTrack
          ? (data.peaks[
              Math.min(
                data.peaks.length - 1,
                Math.floor((sourceTime / data.durationMs) * data.peaks.length),
              )
            ] ?? 0) *
            volume *
            gain
          : 0
        const x = ((i + 0.5) * 1000) / 512
        return `M${x.toFixed(2)},${(40 - peak * 36).toFixed(2)}v${(peak * 72).toFixed(2)}`
      }).join(' ')
    : ''
  return (
    <div className="waveform-track">
      <div className="waveform-label">
        <strong>{label}</strong>
        <small>
          {asset.name} · 原音频 {(asset.durationMs / 1000).toFixed(2)} 秒
          {loop
            ? ' · 循环至成片结束'
            : ` · 起点 ${(offsetMs / 1000).toFixed(3)} 秒`}
        </small>
      </div>
      {data ? (
        <svg
          role="img"
          aria-label={`${label}波形`}
          viewBox="0 0 1000 80"
          preserveAspectRatio="none"
        >
          <rect
            x={Math.min((offsetMs / span) * 1000, 1000)}
            y="0"
            width={Math.max(
              0,
              (Math.min(loop ? span : asset.durationMs, span - offsetMs) /
                span) *
                1000,
            )}
            height="80"
            className="waveform-region"
          />
          <path d="M0,40H1000" className="waveform-baseline" />
          <path d={bars} className="waveform-peaks" />
        </svg>
      ) : (
        <p className="field-hint" role="status">
          {error ||
            (isDesktop ? '正在分析本机音频波形…' : '请在桌面应用中分析波形。')}
        </p>
      )}
      {error && (
        <button
          className="small-button"
          onClick={() => {
            setError('')
            setAttempt((value) => value + 1)
          }}
        >
          重新分析{label}波形
        </button>
      )}
    </div>
  )
}

export function AudioAlignment({
  voice,
  music,
  clips,
  layout,
  effects,
  voiceStartMs,
  musicVolume,
  busy,
  onOffset,
}: {
  voice: AudioAsset | undefined
  music: AudioAsset | undefined
  clips: TimelineClip[]
  layout: ReturnType<typeof timelineLayout>
  effects: TimelineEffects
  voiceStartMs: number
  musicVolume: number
  busy: boolean
  onOffset: (offsetMs: number) => void
}) {
  const totalMs = layout.totalMs
  const maxOffset = Math.max(0, totalMs - 1)
  const disabled = !isDesktop || busy || !voice || totalMs <= 0
  const [input, setInput] = useState<string | null>(null)
  const value = input ?? String(voiceStartMs / 1000)
  function update(text: string) {
    setInput(text)
    const ms = Math.round(Number(text) * 1000)
    if (text.trim() && Number.isFinite(ms) && ms >= 0 && ms <= maxOffset)
      onOffset(ms)
  }
  const invalid =
    input !== null &&
    (!input.trim() ||
      !Number.isFinite(Number(input)) ||
      Number(input) < 0 ||
      Math.round(Number(input) * 1000) > maxOffset)
  return (
    <section className="timeline-section audio-alignment">
      <h3>音频波形与时间对齐</h3>
      <p className="field-hint">
        同一时间轴显示配音和音乐。自动字幕随配音起点移动，超出成片的部分会裁掉；原始素材保留。波形为本机分析的单声道峰值概览。
      </p>
      <div className="audio-offset-controls">
        <label className="field-label">
          配音起点 / 秒
          <input
            type="number"
            aria-label="配音起点"
            min={0}
            max={maxOffset / 1000}
            step={0.001}
            value={value}
            disabled={disabled}
            onChange={(e) => update(e.target.value)}
            onBlur={() => setInput(null)}
            aria-invalid={invalid}
          />
        </label>
        <label className="field-label">
          移动配音起点
          <input
            type="range"
            aria-label="移动配音起点"
            min={0}
            max={maxOffset}
            step={1}
            value={Math.min(voiceStartMs, maxOffset)}
            disabled={disabled}
            onChange={(e) => {
              setInput(null)
              onOffset(Number(e.target.value))
            }}
          />
        </label>
        <button
          className="small-button"
          disabled={disabled || voiceStartMs === 0}
          onClick={() => {
            setInput(null)
            onOffset(0)
          }}
        >
          配音回到起点
        </button>
      </div>
      {invalid && (
        <p className="workflow-error" role="alert">
          起点须在 0–{(maxOffset / 1000).toFixed(3)} 秒内；未保存此输入。
        </p>
      )}
      {totalMs > 0 && (
        <>
          <div className="waveform-ruler">
            <span>0 秒</span>
            <span>{(totalMs / 2000).toFixed(3)} 秒</span>
            <span>{(totalMs / 1000).toFixed(3)} 秒</span>
          </div>
          <div className="waveform-clips" aria-label="时间线片段位置">
            {clips.map((clip, i) => (
              <span
                key={clip.versionId}
                style={{
                  left: `${(Math.max(0, layout.startsMs[i]! + (i ? layout.overlapMs / 2 : 0)) / totalMs) * 100}%`,
                  width: `${(Math.max(0, (i + 1 < clips.length ? layout.startsMs[i + 1]! + layout.overlapMs / 2 : totalMs) - layout.startsMs[i]! - (i ? layout.overlapMs / 2 : 0)) / totalMs) * 100}%`,
                }}
                title={`片段 ${i + 1} · ${((clip.trimEndMs - clip.trimStartMs) / 1000).toFixed(3)} 秒`}
              >
                片段 {i + 1}
              </span>
            ))}
            {layout.overlapMs > 0 &&
              layout.startsMs.slice(1).map((start, i) => (
                <i
                  key={i}
                  className="waveform-transition"
                  title={`转场 ${i + 1}`}
                  aria-hidden="true"
                  style={{
                    left: `${(Math.max(0, start) / totalMs) * 100}%`,
                    width: `${(layout.overlapMs / totalMs) * 100}%`,
                  }}
                />
              ))}
          </div>
          {voice && (
            <WaveformTrack
              key={`voice-${voice.versionId}`}
              asset={voice}
              label="配音"
              totalMs={totalMs}
              offsetMs={voiceStartMs}
              loop={false}
              volume={1}
              fadeInMs={effects.voiceFadeInMs}
              fadeOutMs={effects.voiceFadeOutMs}
            />
          )}
          {music && (
            <WaveformTrack
              key={`music-${music.versionId}`}
              asset={music}
              label="音乐"
              totalMs={totalMs}
              offsetMs={0}
              loop
              volume={musicVolume / 100}
              fadeInMs={effects.musicFadeInMs}
              fadeOutMs={effects.musicFadeOutMs}
            />
          )}
        </>
      )}
      {!voice && !music && (
        <p className="field-hint">选择配音或背景音乐后显示波形。</p>
      )}
      {voice && totalMs > 0 && voiceStartMs + voice.durationMs > totalMs && (
        <p className="field-hint">
          配音超出成片的尾部会裁掉。延长时间线可保留完整配音。
        </p>
      )}
    </section>
  )
}
