import type { WulusaiVideoSettings } from './mediaApi'
import { useState } from 'react'
import { getVideoModel, relayVideoModels, videoModeLabels } from './videoModels'

export function VideoRelayFields({
  settings,
  onChange,
}: {
  settings: WulusaiVideoSettings
  onChange: (settings: WulusaiVideoSettings) => void
}) {
  const [address, setAddress] = useState(settings.baseUrl)
  const model = getVideoModel(settings.model)
  return (
    <>
      <label className="field-label">
        视频 API 根地址
        <input
          aria-label="视频 API 根地址"
          type="url"
          required
          maxLength={512}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onBlur={() => {
            if (address.trim() !== settings.baseUrl)
              onChange({ ...settings, baseUrl: address.trim() })
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              e.currentTarget.blur()
            }
          }}
        />
      </label>
      <label className="field-label">
        视频模型
        <select
          aria-label="视频模型"
          value={settings.model}
          onChange={(e) => onChange({ ...settings, model: e.target.value })}
        >
          {relayVideoModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <p className="field-hint" data-testid="video-model-capabilities">
        支持{model.modes.map((mode) => videoModeLabels[mode]).join('、')} ·{' '}
        {model.duration.min}–{model.duration.max} 秒 ·{' '}
        {model.resolutions.join(' / ')}
      </p>
      {model.modes.length > 1 && (
        <label className="field-label">
          生成方式
          <select
            aria-label="视频生成方式"
            value={settings.mode}
            onChange={(e) =>
              onChange({
                ...settings,
                mode: e.target.value as WulusaiVideoSettings['mode'],
              })
            }
          >
            {model.modes.map((mode) => (
              <option key={mode} value={mode}>
                {videoModeLabels[mode]}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="field-hint">
        {settings.mode === 'frame'
          ? '将当前已确认首帧按模型要求的尺寸居中裁剪并发送，原图版本保留。'
          : '文生视频按提示词生成，候选关联当前镜头。'}
        模型返回的实际尺寸和时长会在下载后读取。
      </p>
      {model.ratios.length > 0 && (
        <>
          <label className="field-label">
            画面比例
            <select
              aria-label="视频画面比例"
              value={settings.ratio ?? ''}
              onChange={(e) =>
                onChange({ ...settings, ratio: e.target.value || null })
              }
            >
              <option value="">由模型决定</option>
              {model.ratios.map((ratio) => (
                <option key={ratio}>{ratio}</option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className="field-label">
        本次视频预算预留 / USD
        <input
          aria-label="本次视频预算预留"
          type="number"
          required
          min={0.01}
          max={1000}
          step={0.01}
          value={settings.budgetReservationMicroUsd / 1_000_000}
          onChange={(e) =>
            onChange({
              ...settings,
              budgetReservationMicroUsd: Math.round(
                Number(e.target.value) * 1_000_000,
              ),
            })
          }
        />
      </label>
      <p className="field-hint">
        预算预留由你填写；服务按成片秒数计费，余额与实际扣费以中转站账单为准。
      </p>
      <p className="field-hint">
        这里只列出已适配的模型。模型目录中出现的其他模型，需要核对接口和参数后接入。
      </p>
    </>
  )
}
