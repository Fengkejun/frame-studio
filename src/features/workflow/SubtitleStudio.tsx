import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import * as api from './mediaApi'
import { errorMessage } from './api'
import type { Workflow } from './model'
import {
  TranscriptionSettings,
  type TranscriptionSettingsValue,
} from './TranscriptionSettings'
import { SubtitleEditor } from './SubtitleEditor'
import { MediaBudgetPanel } from './MediaBudgetPanel'
import { useSubtitles } from './useSubtitles'

const storageKey = 'frame-studio.transcription-settings'
function savedSettings(): TranscriptionSettingsValue {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(storageKey) ?? 'null',
    )
    if (
      value &&
      typeof value === 'object' &&
      'baseUrl' in value &&
      typeof value.baseUrl === 'string' &&
      'model' in value &&
      typeof value.model === 'string'
    )
      return { baseUrl: value.baseUrl, model: value.model }
  } catch {
    /* Optional settings; keys are kept in the system credential store. */
  }
  return { baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' }
}

export function SubtitleStudio({
  workflow,
  save,
  voice,
  voiceStartMs,
  timelineDurationMs,
  audio,
  assets,
  setAssets,
  appliedId,
  onApply,
}: {
  workflow: Workflow
  save: (workflow: Workflow) => Promise<void>
  voice: api.AudioAsset | undefined
  voiceStartMs: number
  timelineDurationMs: number
  audio: api.AudioAsset[]
  assets: api.SubtitleAsset[]
  setAssets: Dispatch<SetStateAction<api.SubtitleAsset[]>>
  appliedId: string | null
  onApply: (asset: api.SubtitleAsset, srt: string) => void
}) {
  const [settings, setSettings] = useState(savedSettings)
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [connection, setConnection] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reservation, setReservation] = useState('0.05')
  const [previewId, setPreviewId] = useState<string | null>(null)
  const { jobs, setJobs, active } = useSubtitles(
    workflow.id,
    setAssets,
    setError,
  )
  const preview = assets.find((a) => a.versionId === (previewId ?? appliedId))
  const source = audio.find(
    (a) => a.versionId === preview?.sourceAudioVersionId,
  )
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(settings))
    } catch {
      /* Optional. */
    }
  }, [settings])
  useEffect(() => {
    let alive = true
    void api
      .transcriptionKeyStatus(settings.baseUrl)
      .then((value) => {
        if (alive) setHasKey(value)
      })
      .catch(() => {
        if (alive) setHasKey(false)
      })
    return () => {
      alive = false
    }
  }, [settings.baseUrl])
  async function run(action: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  async function generate() {
    if (!voice) throw new Error('请先选择时间线配音')
    const amount = Number(reservation)
    if (!Number.isFinite(amount) || amount < 0.001 || amount > 1000)
      throw new Error('转写预算预留金额须在 0.001–1000 美元之间')
    await save(workflow)
    const job = await api.startTranscriptionJob({
      workflowId: workflow.id,
      sourceAudioVersionId: voice.versionId,
      ...settings,
      budgetReservationMicroUsd: Math.round(amount * 1_000_000),
    })
    setJobs((values) => [job, ...values])
  }
  async function download(asset: api.SubtitleAsset) {
    const matchesVoice = asset.sourceAudioVersionId === voice?.versionId
    const srt = await api.getSubtitleSrt(
      asset.versionId,
      matchesVoice ? voiceStartMs : 0,
      matchesVoice && timelineDurationMs > 0 ? timelineDurationMs : null,
    )
    const url = URL.createObjectURL(
      new Blob([srt], { type: 'application/x-subrip;charset=utf-8' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `subtitles-${asset.versionId.slice(0, 8)}.srt`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <section className="timeline-section subtitle-studio">
      <h3>配音自动字幕</h3>
      <p className="field-hint">
        识别当前配音的分段时间戳，校对后手动应用到时间线。更换配音后，请使用匹配的字幕版本。
      </p>
      {!isDesktop && (
        <p className="preview-strip">
          请在桌面应用中选择配音、连接转写服务并生成字幕。
        </p>
      )}
      <p className="subtitle-source">
        {voice
          ? `当前配音：${voice.name} · ${(voice.durationMs / 1000).toFixed(2)} 秒 · ${voice.versionId.slice(0, 8)}`
          : '请先在“画面与声音”中选择配音。'}
      </p>
      <TranscriptionSettings
        settings={settings}
        onChange={(value) => {
          if (value.baseUrl !== settings.baseUrl) {
            setHasKey(false)
            setKey('')
          }
          setConnection('')
          setSettings(value)
        }}
        apiKey={key}
        setKey={setKey}
        hasKey={hasKey}
        busy={busy || active}
        connection={connection}
        onSave={() =>
          void run(async () => {
            await api.saveTranscriptionKey(settings.baseUrl, key)
            setKey('')
            setHasKey(true)
            setConnection('密钥已保存到系统凭据库')
          })
        }
        onClear={() =>
          void run(async () => {
            await api.clearTranscriptionKey(settings.baseUrl)
            setHasKey(false)
            setConnection('密钥已删除')
          })
        }
        onCheck={() =>
          void run(async () => {
            const result = await api.checkTranscriptionConnection(
              settings.baseUrl,
              settings.model,
            )
            setConnection(result.message)
          })
        }
      />
      <MediaBudgetPanel workflowId={workflow.id} refreshSignal={jobs.length} />
      <label className="field-label">
        本次转写预算预留 / 美元
        <input
          aria-label="转写预算预留"
          type="number"
          min={0.001}
          max={1000}
          step={0.001}
          value={reservation}
          disabled={busy || active}
          onChange={(e) => setReservation(e.target.value)}
        />
      </label>
      <button
        className="button primary"
        disabled={
          !isDesktop ||
          busy ||
          active ||
          !hasKey ||
          !voice ||
          !settings.model.trim()
        }
        onClick={() => void run(generate)}
      >
        发送当前配音并生成字幕
      </button>
      {error && (
        <p className="workflow-error" role="alert">
          {error}
        </p>
      )}
      <details
        className="transcription-history"
        open={jobs.some(api.isTranscriptionRunning)}
      >
        <summary>字幕识别记录 · {jobs.length}</summary>
        {jobs.map((job) => (
          <article key={job.id} className="transcription-job">
            <strong>
              {job.status === 'succeeded'
                ? '字幕识别完成'
                : job.status === 'failed'
                  ? '字幕识别失败'
                  : job.status === 'unknown'
                    ? '结果待核实'
                    : '正在识别字幕'}
            </strong>
            <small>
              {new Date(job.createdAt).toLocaleString('zh-CN')} · 配音{' '}
              {job.request.sourceAudioVersionId.slice(0, 8)} · 预留{' '}
              {api.formatUsd(job.estimatedCostMicroUsd)}
            </small>
            <p>{job.message}</p>
            {job.assetId && (
              <button
                className="small-button"
                onClick={() => setPreviewId(job.assetId)}
              >
                校对字幕
              </button>
            )}
          </article>
        ))}
      </details>
      <label className="field-label">
        字幕版本预览
        <select
          aria-label="字幕版本预览"
          disabled={busy}
          value={previewId ?? appliedId ?? ''}
          onChange={(e) => setPreviewId(e.target.value)}
        >
          <option value="">选择已生成或校对的字幕</option>
          {assets.map((asset) => (
            <option key={asset.versionId} value={asset.versionId}>
              {asset.parentVersionId ? '校对' : '识别'}{' '}
              {asset.versionId.slice(0, 8)} · 配音{' '}
              {asset.sourceAudioVersionId.slice(0, 8)}
              {asset.sourceAudioVersionId === voice?.versionId
                ? ' · 匹配当前配音'
                : ''}
            </option>
          ))}
        </select>
      </label>
      {preview && source && (
        <SubtitleEditor
          key={preview.versionId}
          asset={preview}
          durationMs={source.durationMs}
          voiceStartMs={
            preview.sourceAudioVersionId === voice?.versionId ? voiceStartMs : 0
          }
          busy={busy}
          appliedId={appliedId}
          matchesVoice={preview.sourceAudioVersionId === voice?.versionId}
          onSave={(cues) =>
            void run(async () => {
              const asset = await api.saveSubtitleVersion(
                workflow.id,
                preview.versionId,
                cues,
              )
              setAssets((values) => [asset, ...values])
              setPreviewId(asset.versionId)
            })
          }
          onApply={() =>
            void run(async () => {
              const srt = await api.getSubtitleSrt(preview.versionId)
              onApply(preview, srt)
            })
          }
          onDownload={() => void run(() => download(preview))}
        />
      )}
    </section>
  )
}
