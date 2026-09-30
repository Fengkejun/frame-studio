import { isDesktop } from '@/shared/lib/desktop'

export interface TranscriptionSettingsValue {
  baseUrl: string
  model: string
}
export function TranscriptionSettings({
  settings,
  onChange,
  apiKey,
  setKey,
  hasKey,
  busy,
  connection,
  onSave,
  onClear,
  onCheck,
}: {
  settings: TranscriptionSettingsValue
  onChange: (value: TranscriptionSettingsValue) => void
  apiKey: string
  setKey: (value: string) => void
  hasKey: boolean
  busy: boolean
  connection: string
  onSave: () => void
  onClear: () => void
  onCheck: () => void
}) {
  return (
    <details className="transcription-connection">
      <summary>字幕识别服务 · {hasKey ? '密钥已保存' : '待配置密钥'}</summary>
      <div className="timeline-settings-grid">
        <label className="field-label">
          转写 API 根地址
          <input
            aria-label="转写 API 根地址"
            disabled={busy}
            value={settings.baseUrl}
            onChange={(e) => onChange({ ...settings, baseUrl: e.target.value })}
          />
        </label>
        <label className="field-label">
          转写模型 ID
          <input
            aria-label="转写模型 ID"
            disabled={busy}
            value={settings.model}
            onChange={(e) => onChange({ ...settings, model: e.target.value })}
          />
        </label>
        <label className="field-label">
          API Key
          <input
            type="password"
            aria-label="转写 API Key"
            autoComplete="off"
            disabled={!isDesktop || busy}
            value={apiKey}
            onChange={(e) => setKey(e.target.value)}
            placeholder={hasKey ? '已保存在系统凭据库' : '填入转写服务密钥'}
          />
        </label>
      </div>
      <p className="field-hint">
        建议
        whisper-1。服务须支持分段时间戳；模型目录检查只验证连接，生成会上传当前配音并按服务商规则计费。
      </p>
      <div className="form-actions">
        <button
          className="small-button"
          disabled={!isDesktop || busy || !apiKey.trim()}
          onClick={onSave}
        >
          保存转写密钥
        </button>
        <button
          className="small-button"
          disabled={!isDesktop || busy || !hasKey}
          onClick={onClear}
        >
          删除转写密钥
        </button>
        <button
          className="small-button"
          disabled={!isDesktop || busy || !hasKey}
          onClick={onCheck}
        >
          检查转写服务
        </button>
      </div>
      {connection && (
        <p className="field-hint" role="status">
          {connection}
        </p>
      )}
    </details>
  )
}
