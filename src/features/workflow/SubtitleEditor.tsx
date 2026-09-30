import { useState } from 'react'
import type { SubtitleAsset, SubtitleCue } from './mediaApi'

export function SubtitleEditor({
  asset,
  durationMs,
  busy,
  matchesVoice,
  appliedId,
  onSave,
  onApply,
  onDownload,
}: {
  asset: SubtitleAsset
  durationMs: number
  busy: boolean
  matchesVoice: boolean
  appliedId: string | null
  onSave: (cues: SubtitleCue[]) => void
  onApply: () => void
  onDownload: () => void
}) {
  const [cues, setCues] = useState(asset.cues)
  const changed = JSON.stringify(cues) !== JSON.stringify(asset.cues)
  const invalid =
    !cues.length ||
    cues.some(
      (cue, i) =>
        !Number.isInteger(cue.startMs) ||
        !Number.isInteger(cue.endMs) ||
        cue.startMs < (cues[i - 1]?.endMs ?? 0) ||
        cue.endMs <= cue.startMs ||
        cue.endMs > durationMs ||
        !cue.text.trim() ||
        Array.from(cue.text).length > 1000 ||
        Array.from(cue.text).some(
          (ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127,
        ) ||
        /[<>{}]|-->/.test(cue.text),
    )
  function patch(index: number, value: Partial<SubtitleCue>) {
    setCues(cues.map((cue, i) => (i === index ? { ...cue, ...value } : cue)))
  }
  return (
    <div className="subtitle-editor">
      <p className="field-hint">
        字幕版本 {asset.versionId.slice(0, 8)} · 配音版本{' '}
        {asset.sourceAudioVersionId.slice(0, 8)} · {cues.length}{' '}
        段。时间从成片开始计算，配音从 0 秒播放。
      </p>
      {!matchesVoice && (
        <p className="workflow-error">
          此字幕属于另一配音版本，请选择匹配的配音再应用。
        </p>
      )}
      <div className="subtitle-cues">
        {cues.map((cue, i) => (
          <div className="subtitle-cue" key={i}>
            <span>{i + 1}</span>
            <label className="field-label">
              开始 / 秒
              <input
                type="number"
                aria-label={`字幕 ${i + 1} 开始`}
                min={0}
                max={durationMs / 1000}
                step={0.001}
                value={Number.isFinite(cue.startMs) ? cue.startMs / 1000 : ''}
                disabled={busy}
                onChange={(e) =>
                  patch(i, {
                    startMs: Math.round(e.target.valueAsNumber * 1000),
                  })
                }
              />
            </label>
            <label className="field-label">
              结束 / 秒
              <input
                type="number"
                aria-label={`字幕 ${i + 1} 结束`}
                min={0}
                max={durationMs / 1000}
                step={0.001}
                value={Number.isFinite(cue.endMs) ? cue.endMs / 1000 : ''}
                disabled={busy}
                onChange={(e) =>
                  patch(i, { endMs: Math.round(e.target.valueAsNumber * 1000) })
                }
              />
            </label>
            <label className="field-label subtitle-text">
              字幕文本
              <input
                aria-label={`字幕 ${i + 1} 文本`}
                maxLength={1000}
                value={cue.text}
                disabled={busy}
                onChange={(e) => patch(i, { text: e.target.value })}
              />
            </label>
            <button
              className="text-button"
              disabled={busy}
              onClick={() => setCues(cues.filter((_, n) => n !== i))}
            >
              删除第 {i + 1} 段
            </button>
          </div>
        ))}
      </div>
      {invalid && (
        <p className="workflow-error" role="alert">
          请填写纯文本，起止时间须递增、不重叠且在配音时长内。
        </p>
      )}
      {changed && (
        <p className="field-hint">
          有未保存的修改，请先保存为新版本再应用或下载。
        </p>
      )}
      <div className="form-actions">
        <button
          className="small-button"
          disabled={
            busy ||
            cues.length >= 1000 ||
            (cues.at(-1)?.endMs ?? 0) >= durationMs
          }
          onClick={() => {
            const startMs = cues.at(-1)?.endMs ?? 0
            setCues([
              ...cues,
              {
                startMs,
                endMs: Math.min(startMs + 1000, durationMs),
                text: '',
              },
            ])
          }}
        >
          添加字幕段
        </button>
        <button
          className="small-button"
          disabled={busy || invalid || !changed}
          onClick={() => onSave(cues)}
        >
          保存字幕新版本
        </button>
        <button
          className="button primary"
          disabled={
            busy ||
            changed ||
            invalid ||
            !matchesVoice ||
            appliedId === asset.versionId
          }
          onClick={onApply}
        >
          {appliedId === asset.versionId
            ? '已应用到时间线'
            : '应用字幕到时间线'}
        </button>
        <button
          className="small-button"
          disabled={busy || changed || invalid}
          onClick={onDownload}
        >
          下载 SRT
        </button>
      </div>
    </div>
  )
}
