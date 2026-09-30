import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from './api'
import * as api from './mediaApi'
import { AudioPreview } from './AudioPreview'
import { MediaBudgetPanel } from './MediaBudgetPanel'
import type { Workflow } from './model'

const storageKey = 'frame-studio.speech-settings'
const defaults = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini-tts',
  voice: 'coral',
  speed: 1,
}
function savedSettings(): typeof defaults {
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
      typeof value.model === 'string' &&
      'voice' in value &&
      typeof value.voice === 'string' &&
      'speed' in value &&
      typeof value.speed === 'number'
    ) {
      return {
        baseUrl: value.baseUrl,
        model: value.model,
        voice: value.voice,
        speed: value.speed,
      }
    }
  } catch {
    /* Settings are optional; keys live only in the system credential store. */
  }
  return defaults
}

export function VoiceoverStudio({
  workflow,
  save,
  assets,
  setAssets,
  selectedId,
  onUse,
  captions,
}: {
  workflow: Workflow
  save: (workflow: Workflow) => Promise<void>
  assets: api.AudioAsset[]
  setAssets: Dispatch<SetStateAction<api.AudioAsset[]>>
  selectedId: string | null
  onUse: (versionId: string) => void
  captions: string
}) {
  const [settings, setSettings] = useState(savedSettings)
  const [input, setInput] = useState('')
  const [reservation, setReservation] = useState('0.05')
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [jobs, setJobs] = useState<api.SpeechJob[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [connection, setConnection] = useState('')
  const active = jobs.some(api.isSpeechRunning)
  const length = Array.from(input).length

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
      .speechKeyStatus(settings.baseUrl)
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
  useEffect(() => {
    let alive = true
    void api
      .listSpeechJobs(workflow.id)
      .then((values) => {
        if (!alive) return
        setJobs(values)
        setInput((current) => current || values[0]?.request.input || '')
      })
      .catch((reason) => {
        if (alive) setError(errorMessage(reason))
      })
    return () => {
      alive = false
    }
  }, [workflow.id])
  useEffect(() => {
    if (!active) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const values = await api.listSpeechJobs(workflow.id)
        // Read assets after job status, so a completed job never hides its asset.
        const audio = await api.listAudioAssets(workflow.id)
        if (alive) {
          setJobs(values)
          setAssets(audio)
        }
      } catch (reason) {
        if (alive) setError(errorMessage(reason))
      }
      if (alive) timer = setTimeout(() => void poll(), 800)
    }
    timer = setTimeout(() => void poll(), 800)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [active, workflow.id, setAssets])

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
    const amount = Number(reservation)
    if (!Number.isFinite(amount) || amount < 0.001 || amount > 1000)
      throw new Error('配音预算预留金额须在 0.001–1000 美元之间')
    await save(workflow)
    const job = await api.startSpeechJob({
      workflowId: workflow.id,
      ...settings,
      input,
      budgetReservationMicroUsd: Math.round(amount * 1_000_000),
    })
    setJobs((values) => [job, ...values])
  }
  return (
    <section className="timeline-section voiceover-studio">
      <h3>AI 配音生成</h3>
      <p className="field-hint">
        填写旁白，生成独立音频版本。试听后点击“用作配音”加入时间线；生成的声音为
        AI 合成声音。
      </p>
      {!isDesktop && (
        <p className="preview-strip">请在桌面应用中连接语音服务并生成配音。</p>
      )}
      <details className="speech-connection">
        <summary>语音服务设置 · {hasKey ? '密钥已保存' : '待配置密钥'}</summary>
        <div className="timeline-settings-grid">
          <label className="field-label">
            语音 API 根地址
            <input
              aria-label="语音 API 根地址"
              value={settings.baseUrl}
              disabled={busy || active}
              onChange={(event) => {
                setHasKey(false)
                setKey('')
                setConnection('')
                setSettings({ ...settings, baseUrl: event.target.value })
              }}
            />
          </label>
          <label className="field-label">
            配音模型 ID
            <input
              aria-label="配音模型 ID"
              value={settings.model}
              disabled={busy || active}
              list="speech-models"
              onChange={(event) => {
                setConnection('')
                setSettings({ ...settings, model: event.target.value })
              }}
            />
            <datalist id="speech-models">
              <option value="gpt-4o-mini-tts" />
              <option value="tts-1" />
              <option value="tts-1-hd" />
            </datalist>
          </label>
          <label className="field-label">
            API Key
            <input
              type="password"
              aria-label="配音 API Key"
              autoComplete="off"
              value={key}
              disabled={!isDesktop || busy || active}
              placeholder={
                hasKey ? '已保存在系统凭据库' : '填入当前语音服务密钥'
              }
              onChange={(event) => setKey(event.target.value)}
            />
          </label>
        </div>
        <div className="form-actions">
          <button
            className="small-button"
            disabled={!isDesktop || busy || active || !key.trim()}
            onClick={() =>
              void run(async () => {
                await api.saveSpeechKey(settings.baseUrl, key)
                setKey('')
                setHasKey(true)
                setConnection('密钥已保存到系统凭据库')
              })
            }
          >
            保存配音密钥
          </button>
          <button
            className="small-button"
            disabled={!isDesktop || busy || active || !hasKey}
            onClick={() =>
              void run(async () => {
                await api.clearSpeechKey(settings.baseUrl)
                setHasKey(false)
                setConnection('密钥已删除')
              })
            }
          >
            删除配音密钥
          </button>
          <button
            className="small-button"
            disabled={!isDesktop || busy || active || !hasKey}
            onClick={() =>
              void run(async () => {
                const value = await api.checkSpeechConnection(
                  settings.baseUrl,
                  settings.model,
                )
                setConnection(value.message)
              })
            }
          >
            检查语音服务
          </button>
        </div>
        <p className="field-hint">
          兼容 POST /v1/audio/speech，返回 WAV
          文件。连接检查只读取模型目录，实际语音权限以生成结果为准。
        </p>
        {connection && <p className="field-hint">{connection}</p>}
      </details>
      <label className="field-label">
        旁白文本 · {length} / 4096 字
        <textarea
          aria-label="旁白文本"
          rows={5}
          value={input}
          disabled={busy || active}
          onChange={(event) => setInput(event.target.value)}
          placeholder="输入需要朗读的旁白…"
        />
      </label>
      <button
        className="text-button"
        disabled={!captions || busy || active}
        onClick={() => setInput(captions)}
      >
        使用时间线字幕
      </button>
      <div className="timeline-settings-grid">
        <label className="field-label">
          配音音色
          <select
            aria-label="配音音色"
            value={settings.voice}
            disabled={busy || active}
            onChange={(event) =>
              setSettings({ ...settings, voice: event.target.value })
            }
          >
            {[
              'alloy',
              'ash',
              'ballad',
              'coral',
              'echo',
              'sage',
              'shimmer',
              'verse',
              'marin',
              'cedar',
            ].map((voice) => (
              <option key={voice}>{voice}</option>
            ))}
          </select>
        </label>
        <label className="field-label">
          配音语速
          <input
            type="number"
            aria-label="配音语速"
            min={0.25}
            max={4}
            step={0.05}
            value={settings.speed}
            disabled={busy || active}
            onChange={(event) =>
              setSettings({ ...settings, speed: Number(event.target.value) })
            }
          />
        </label>
        <label className="field-label">
          本次配音预算预留 / USD
          <input
            type="number"
            aria-label="配音预算预留"
            min={0.001}
            max={1000}
            step={0.001}
            value={reservation}
            disabled={busy || active}
            onChange={(event) => setReservation(event.target.value)}
          />
        </label>
      </div>
      <p className="field-hint">
        不同模型支持的音色和语速可能不同；费用按服务商账单结算，请按其报价填写预留金额。
      </p>
      <button
        className="button primary"
        disabled={
          !isDesktop ||
          busy ||
          active ||
          !hasKey ||
          !input.trim() ||
          length > 4096 ||
          !settings.model.trim()
        }
        onClick={() => void run(generate)}
      >
        {active ? '配音生成中…' : '生成配音'}
      </button>
      {error && (
        <p className="workflow-error" role="alert">
          {error}
        </p>
      )}
      {isDesktop && (
        <MediaBudgetPanel
          workflowId={workflow.id}
          refreshSignal={jobs.length}
        />
      )}
      <div className="speech-history">
        <h4>配音版本与任务记录</h4>
        {!jobs.length && <p className="media-empty">还没有生成配音。</p>}
        {jobs.map((job) => {
          const asset = assets.find((item) => item.versionId === job.assetId)
          return (
            <article className="speech-job" key={job.id}>
              <strong>
                {job.status === 'succeeded'
                  ? '配音已完成'
                  : api.isSpeechRunning(job)
                    ? '生成中'
                    : job.status === 'unknown'
                      ? '结果待核实'
                      : '配音失败'}
              </strong>
              <small>
                {job.request.voice} · {job.request.speed}x ·{' '}
                {new Date(job.createdAt).toLocaleString('zh-CN')} · 预留{' '}
                {api.formatUsd(job.estimatedCostMicroUsd)}
              </small>
              <p>{job.message}</p>
              <details>
                <summary>查看旁白与模型</summary>
                <p>{job.request.model}</p>
                <p className="speech-text">{job.request.input}</p>
              </details>
              {asset && (
                <>
                  <AudioPreview
                    key={asset.versionId}
                    versionId={asset.versionId}
                  />
                  <button
                    className="small-button"
                    disabled={selectedId === asset.versionId}
                    onClick={() => onUse(asset.versionId)}
                  >
                    {selectedId === asset.versionId ? '已用作配音' : '用作配音'}
                  </button>
                  <small>
                    {(asset.durationMs / 1000).toFixed(1)} 秒 · 版本{' '}
                    {asset.versionId.slice(0, 8)}
                  </small>
                </>
              )}
              {job.status === 'unknown' && (
                <p className="field-hint">
                  已保留任务与预算记录。核对服务商用量后再决定是否手动生成新版本。
                </p>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
