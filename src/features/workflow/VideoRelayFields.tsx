import type { WulusaiVideoSettings } from './mediaApi'
import { useState } from 'react'

export function VideoRelayFields({
  settings,
  onChange,
}: {
  settings: WulusaiVideoSettings
  onChange: (settings: WulusaiVideoSettings) => void
}) {
  const [address, setAddress] = useState(settings.baseUrl)
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
          <option value="minimax-h3">MiniMax-H3</option>
          <option value="grok-imagine-video-1.5-lite">
            Grok Imagine Video 1.5 Lite
          </option>
        </select>
      </label>
      {settings.model === 'grok-imagine-video-1.5-lite' && (
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
            <option value="text">文生视频</option>
            <option value="frame">首帧图生视频</option>
          </select>
        </label>
      )}
      <p className="field-hint">
        {settings.mode === 'frame'
          ? '将当前已确认首帧居中裁剪为所选的 16:9 尺寸并发送给视频模型，原图版本保留。'
          : '文生视频按提示词生成，候选关联当前镜头。'}
        模型返回的实际尺寸和时长会在下载后读取。
      </p>
      {settings.model !== 'grok-imagine-video-1.5-lite' && (
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
              {['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'].map((ratio) => (
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
    </>
  )
}
