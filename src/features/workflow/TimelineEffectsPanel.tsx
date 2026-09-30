import { useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import type { TimelineEffects } from './mediaApi'

function SecondsField({
  label,
  value,
  max,
  min = 0,
  disabled,
  onChange,
}: {
  label: string
  value: number
  max: number
  min?: number
  disabled: boolean
  onChange: (ms: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  const number = Number(text ?? value / 1000)
  const invalid =
    text !== null &&
    (!text.trim() ||
      !Number.isFinite(number) ||
      number * 1000 < min ||
      number * 1000 > max)
  return (
    <label className="field-label">
      {label} / 秒
      <input
        type="number"
        aria-label={label}
        value={text ?? value / 1000}
        min={min / 1000}
        max={max / 1000}
        step={0.05}
        disabled={disabled}
        aria-invalid={invalid}
        onBlur={() => setText(null)}
        onChange={(e) => {
          setText(e.target.value)
          const ms = Math.round(Number(e.target.value) * 1000)
          if (
            e.target.value.trim() &&
            Number.isFinite(ms) &&
            ms >= min &&
            ms <= max
          )
            onChange(ms)
        }}
      />
      {invalid && (
        <small role="alert">
          请输入 {(min / 1000).toFixed(2)}–{max / 1000} 秒；此输入未保存。
        </small>
      )}
    </label>
  )
}

export function TimelineEffectsPanel({
  effects,
  totalMs,
  clipCount,
  invalidTransition,
  fadeError,
  hasVoice,
  hasMusic,
  busy,
  onChange,
}: {
  effects: TimelineEffects
  totalMs: number
  clipCount: number
  invalidTransition: boolean
  fadeError: string
  hasVoice: boolean
  hasMusic: boolean
  busy: boolean
  onChange: (patch: Partial<TimelineEffects>) => void
}) {
  const disabled = !isDesktop || busy
  return (
    <section className="timeline-section timeline-effects">
      <h3>镜头转场与音频淡入淡出</h3>
      <div className="timeline-fields">
        <label className="field-label">
          镜头转场
          <select
            aria-label="镜头转场"
            value={effects.transition}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                transition: e.target.value as TimelineEffects['transition'],
              })
            }
          >
            <option value="none">直接切换</option>
            <option value="fade">交叉溶解</option>
            <option value="fadeblack">经黑场切换</option>
          </select>
        </label>
        <SecondsField
          label="转场时长"
          value={effects.transitionDurationMs}
          min={100}
          max={2000}
          disabled={disabled || effects.transition === 'none'}
          onChange={(transitionDurationMs) =>
            onChange({ transitionDurationMs })
          }
        />
      </div>
      <p className="field-hint">
        相邻镜头共用转场设置。转场在镜头尾部与下一镜头头部重叠，成片总时长随之缩短；片段字幕在转场中点切换。时间按
        30 fps 帧边界计算，当前成片 {(totalMs / 1000).toFixed(3)} 秒。
      </p>
      {clipCount < 2 && effects.transition !== 'none' && (
        <p className="field-hint">至少加入两个镜头后才会产生转场。</p>
      )}
      {invalidTransition && (
        <p className="workflow-error" role="alert">
          转场时长须不超过任一片段时长的一半；请缩短转场或延长片段。
        </p>
      )}
      <div className="timeline-fields">
        <SecondsField
          label="音乐淡入"
          value={effects.musicFadeInMs}
          max={10000}
          disabled={disabled || !hasMusic}
          onChange={(musicFadeInMs) => onChange({ musicFadeInMs })}
        />
        <SecondsField
          label="音乐淡出"
          value={effects.musicFadeOutMs}
          max={10000}
          disabled={disabled || !hasMusic}
          onChange={(musicFadeOutMs) => onChange({ musicFadeOutMs })}
        />
        <SecondsField
          label="配音淡入"
          value={effects.voiceFadeInMs}
          max={10000}
          disabled={disabled || !hasVoice}
          onChange={(voiceFadeInMs) => onChange({ voiceFadeInMs })}
        />
        <SecondsField
          label="配音淡出"
          value={effects.voiceFadeOutMs}
          max={10000}
          disabled={disabled || !hasVoice}
          onChange={(voiceFadeOutMs) => onChange({ voiceFadeOutMs })}
        />
      </div>
      <p className="field-hint">
        0
        秒关闭效果。音乐在成片起止处淡入淡出；配音从设定起点淡入，并在源配音结束或成片截断处淡出。自动字幕保持与配音同步；导入字幕仍按成片时间。
      </p>
      {fadeError && (
        <p className="workflow-error" role="alert">
          {fadeError}
        </p>
      )}
    </section>
  )
}
