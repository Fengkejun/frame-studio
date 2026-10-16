import { useEffect, useRef, useState } from 'react'
import * as api from './mediaApi'
import { errorMessage } from './api'
import { isDesktop } from '@/shared/lib/desktop'
import { suggestedCues, voiceCueError } from './timelineReview'

export function ShotVoiceAlignment({
  draft,
  voice,
  busy,
  onChange,
}: {
  draft: api.Composition
  voice: api.AudioAsset | undefined
  busy: boolean
  onChange: (draft: api.Composition) => void
}) {
  const current = useRef<api.Composition | null>(draft)
  useEffect(() => {
    current.current = draft
    return () => {
      current.current = null
    }
  }, [draft])
  const [jobs, setJobs] = useState<api.SpeechJob[]>([])
  const [analyzing, setAnalyzing] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void api
      .listSpeechJobs(draft.workflowId)
      .then((v) => {
        if (alive) setJobs(v)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [draft.workflowId, voice?.versionId])
  const selected = jobs.find(
    (j) => j.assetId === voice?.versionId && j.status === 'succeeded',
  )
  const lines = selected?.request.input
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const sameText =
    !!lines &&
    lines.length === draft.clips.length &&
    lines.every((line, i) => line === draft.clips[i]?.caption.trim())
  const disabled =
    busy || analyzing || !voice || !isDesktop || !draft.clips.length
  function apply(cues: api.VoiceCue[]) {
    onChange({
      ...draft,
      voiceCues: cues,
      voiceStartMs: 0,
      subtitleVersionId: null,
      subtitleFormat: 'none',
      subtitleText: '',
      effects: { ...draft.effects, voiceFadeInMs: 0, voiceFadeOutMs: 0 },
    })
  }
  async function suggest() {
    if (!voice || !sameText) return
    setAnalyzing(true)
    setError('')
    try {
      const wave = await api.getAudioWaveform(voice.versionId)
      if (current.current !== draft)
        throw new Error('时间线或配音已变化，请重新分析；尚未应用旧结果。')
      const cues = suggestedCues(draft.clips, wave)
      const next: api.Composition = {
        ...draft,
        voiceCues: cues,
        voiceStartMs: 0,
        subtitleVersionId: null,
        subtitleFormat: 'none',
        subtitleText: '',
        effects: { ...draft.effects, voiceFadeInMs: 0, voiceFadeOutMs: 0 },
      }
      const reason = voiceCueError(next, voice.durationMs)
      if (reason) throw new Error(reason)
      apply(cues)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setAnalyzing(false)
    }
  }
  return (
    <section className="timeline-section shot-voice-alignment">
      <h3>按镜头对齐配音与字幕</h3>
      <p className="field-hint">
        将同一份配音中的不同句子放到各自镜头起点，字幕随对应语音段出现。原音频保留；不重新生成或收费。启用时改用片段台词字幕，并清除全局配音偏移和淡化。
      </p>
      <button
        className="small-button"
        disabled={disabled || !sameText}
        onClick={() => void suggest()}
      >
        {analyzing ? '正在分析停顿…' : '按台词与停顿对齐'}
      </button>
      {!sameText && (
        <p className="field-hint">
          自动对齐要求：当前配音生成文本逐行对应镜头台词，顺序和句数一致。导入音频或文本不匹配时，请手动设置源音频区间。
        </p>
      )}
      <small>
        停顿分析只是分句建议，不识别语义。请核对区间并试听原音频；每段声音须放得进对应镜头。
      </small>
      {draft.clips.map((clip, i) => {
        const cue = draft.voiceCues?.find(
          (c) => c.clipVersionId === clip.versionId,
        )
        return (
          <div key={clip.versionId} className="timeline-fields">
            <strong>
              片段 {i + 1} · {clip.caption || '无台词'}
            </strong>
            {cue ? (
              <>
                {(['sourceStartMs', 'sourceEndMs'] as const).map((key, j) => (
                  <label className="field-label" key={key}>
                    源配音{j ? '结束' : '开始'} / 秒
                    <input
                      aria-label={`片段 ${i + 1} 配音${j ? '结束' : '开始'}`}
                      type="number"
                      min="0"
                      max={(voice?.durationMs ?? 0) / 1000}
                      step="0.01"
                      value={cue[key] / 1000}
                      disabled={disabled}
                      onChange={(e) =>
                        apply(
                          (draft.voiceCues ?? []).map((c) =>
                            c.clipVersionId === clip.versionId
                              ? {
                                  ...c,
                                  [key]: Math.round(
                                    Number(e.target.value) * 1000,
                                  ),
                                }
                              : c,
                          ),
                        )
                      }
                    />
                  </label>
                ))}
                <button
                  className="text-button"
                  disabled={disabled}
                  onClick={() =>
                    apply(
                      (draft.voiceCues ?? []).filter(
                        (c) => c.clipVersionId !== clip.versionId,
                      ),
                    )
                  }
                >
                  移除此句配音
                </button>
              </>
            ) : (
              <button
                className="text-button"
                disabled={disabled}
                onClick={() =>
                  apply([
                    ...(draft.voiceCues ?? []),
                    {
                      clipVersionId: clip.versionId,
                      sourceStartMs: 0,
                      sourceEndMs: Math.min(
                        1000,
                        voice?.durationMs ?? 1000,
                        clip.trimEndMs - clip.trimStartMs,
                      ),
                    },
                  ])
                }
              >
                设置此镜头配音区间
              </button>
            )}
          </div>
        )
      })}
      {!!draft.voiceCues?.length && (
        <button
          className="text-button"
          disabled={disabled}
          onClick={() => onChange({ ...draft, voiceCues: [] })}
        >
          恢复整段配音
        </button>
      )}
      {(error || voiceCueError(draft, voice?.durationMs)) && (
        <p role="alert" className="workflow-error">
          {error || voiceCueError(draft, voice?.durationMs)}
        </p>
      )}
    </section>
  )
}
