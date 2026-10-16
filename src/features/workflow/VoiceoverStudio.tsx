import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from './api'
import * as api from './mediaApi'
import { AudioPreview } from './AudioPreview'
import { MediaBudgetPanel } from './MediaBudgetPanel'
import type { Workflow } from './model'
import { useSpeechVoices } from './useSpeechVoices'

const storageKey = 'frame-studio.speech-settings'
const namesKey = 'frame-studio.voice-nicknames'
const auditionText =
  '你好，欢迎来到帧序工作室。这是一段音色试听，请听听我的声音是否适合你的角色。'
const geminiModels = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts']
const instructionModels = [
  ...geminiModels,
  'gpt-4o-mini-tts',
  'gpt-4o-mini-tts-2025-12-15',
]
function savedNames(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(namesKey) ?? '{}')
    if (value && typeof value === 'object' && !Array.isArray(value))
      return Object.fromEntries(
        Object.entries(value).filter(
          ([, name]) => typeof name === 'string' && name.length <= 20,
        ),
      )
  } catch {
    /* Optional local nicknames. */
  }
  return {}
}
const defaults = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini-tts',
  voice: '',
  speed: 1,
  responseFormat: 'wav' as 'wav' | 'mp3',
  instructions: '',
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
        responseFormat:
          'responseFormat' in value && value.responseFormat === 'mp3'
            ? 'mp3'
            : 'wav',
        instructions:
          'instructions' in value && typeof value.instructions === 'string'
            ? value.instructions
            : '',
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
  const [nicknames, setNicknames] = useState(savedNames)
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
  const voices = useSpeechVoices(settings.baseUrl, settings.model)
  const voiceReady =
    !!voices.catalog &&
    voices.catalog.voices.some((v) => v.id === settings.voice)
  const isGemini = geminiModels.includes(settings.model)
  const allowsInstructions = instructionModels.includes(settings.model)
  const nameScope = (voice: string) =>
    JSON.stringify([
      settings.baseUrl.replace(/\/+$/, ''),
      settings.model,
      voice,
    ])
  const selectedVoice = voices.catalog?.voices.find(
    (v) => v.id === settings.voice,
  )
  const audition = jobs.find(
    (job) =>
      job.status === 'succeeded' &&
      assets.some((a) => a.versionId === job.assetId) &&
      job.request.baseUrl.replace(/\/+$/, '') ===
        settings.baseUrl.replace(/\/+$/, '') &&
      job.request.model === settings.model &&
      job.request.voice === settings.voice &&
      job.request.speed === settings.speed &&
      (job.request.responseFormat ?? 'wav') === settings.responseFormat &&
      (job.request.instructions ?? '') ===
        (allowsInstructions ? settings.instructions : ''),
  )
  useEffect(() => {
    try {
      localStorage.setItem(namesKey, JSON.stringify(nicknames))
    } catch {
      /* Optional. */
    }
  }, [nicknames])

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
  async function generate(text = input) {
    if (!voiceReady || !voices.catalog)
      throw new Error('请先获取当前模型的音色列表，再选择音色生成配音')
    const amount = Number(reservation)
    if (!Number.isFinite(amount) || amount < 0.001 || amount > 1000)
      throw new Error('配音预算预留金额须在 0.001–1000 美元之间')
    await save(workflow)
    const job = await api.startSpeechJob({
      workflowId: workflow.id,
      ...settings,
      instructions: allowsInstructions ? settings.instructions : '',
      voiceCatalogId: voices.catalog.id,
      input: text,
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
                setSettings({
                  ...settings,
                  baseUrl: event.target.value,
                  voice: '',
                })
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
                setError('')
                setSettings({
                  ...settings,
                  model: event.target.value,
                  voice: '',
                  responseFormat: event.target.value.startsWith('mai-voice-')
                    ? 'mp3'
                    : geminiModels.includes(event.target.value)
                      ? 'wav'
                      : settings.responseFormat,
                  speed: geminiModels.includes(event.target.value)
                    ? 1
                    : settings.speed,
                  instructions: instructionModels.includes(event.target.value)
                    ? settings.instructions
                    : '',
                })
              }}
            />
            <datalist id="speech-models">
              <option value="mai-voice-2.1" />
              <option value="mai-voice-2.1-flash" />
              <option value="gemini-3.8-flash-lite-tts" />
              <option value="gemini-3.8-flash-tts" />
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
                voices.refresh()
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
                voices.refresh()
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
          兼容 POST /v1/audio/speech，支持 WAV / MP3 和服务商自定义音色 ID。
          连接检查只读取模型目录，实际语音权限以生成结果为准。
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
            value={voiceReady ? settings.voice : ''}
            disabled={busy || active || !voices.catalog || voices.loading}
            onChange={(event) => {
              setError('')
              setSettings({ ...settings, voice: event.target.value })
            }}
          >
            <option value="">
              {voices.loading ? '正在获取模型音色…' : '请选择当前模型的音色'}
            </option>
            {voices.catalog?.voices.map((voice) => (
              <option key={voice.id} value={voice.id}>
                {nicknames[nameScope(voice.id)]
                  ? `${nicknames[nameScope(voice.id)]} · ${voice.name}`
                  : voice.name}
                {voice.description ? ` · ${voice.description}` : ''} ·{' '}
                {voice.locale === 'multilingual' ? '多语言' : voice.locale}
                {voice.gender === 'Female'
                  ? ' · 女声'
                  : voice.gender === 'Male'
                    ? ' · 男声'
                    : ''}
              </option>
            ))}
          </select>
          <small>
            {voices.catalog
              ? `${voices.catalog.source === 'official_live' ? '微软官方在线目录' : `${isGemini ? 'Google Gemini' : 'OpenAI'} 官方文档目录（2026-10-16 核对）`} · ${voices.catalog.voices.length} 个音色。中转站实际开放范围需单独验证。`
              : '先获取当前模型的官方音色目录，再选择音色。'}
          </small>
          <button
            className="text-button"
            type="button"
            disabled={!isDesktop || busy || active || voices.loading}
            onClick={voices.refresh}
          >
            刷新音色列表
          </button>
          {voices.error && (
            <small className="workflow-error" role="alert">
              {voices.error}
            </small>
          )}
        </label>
        <label className="field-label">
          配音文件格式
          <select
            aria-label="配音文件格式"
            value={settings.responseFormat}
            disabled={busy || active || isGemini}
            onChange={(event) =>
              setSettings({
                ...settings,
                responseFormat: event.target.value as 'wav' | 'mp3',
              })
            }
          >
            <option value="wav">WAV</option>
            <option value="mp3">MP3</option>
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
            disabled={busy || active || isGemini}
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
      {allowsInstructions && (
        <label className="field-label">
          朗读要求
          <textarea
            aria-label="朗读要求"
            rows={2}
            maxLength={4096}
            value={settings.instructions}
            disabled={busy || active}
            placeholder="例如：语气温暖、吐字清晰，适合治愈动画旁白。"
            onChange={(event) =>
              setSettings({ ...settings, instructions: event.target.value })
            }
          />
          <small>
            {isGemini
              ? '当前 Gemini 接口使用 WAV；语气、情绪和语速可在此描述。'
              : '描述语气、情绪和表达方式，此内容作为独立朗读要求发送。'}
          </small>
        </label>
      )}
      <section className="voice-audition" aria-label="音色试听与备注">
        <h4>
          {voiceReady && selectedVoice
            ? `${nicknames[nameScope(settings.voice)] || selectedVoice.name}${selectedVoice.description ? ` · ${selectedVoice.description}` : ''}`
            : '选择音色后试听'}
        </h4>
        <label className="field-label">
          音色备注名
          <input
            aria-label="音色备注名"
            maxLength={20}
            placeholder="例如：小美、小帅、温柔旁白"
            disabled={!voiceReady || busy || active}
            value={nicknames[nameScope(settings.voice)] ?? ''}
            onChange={(event) =>
              setNicknames({
                ...nicknames,
                [nameScope(settings.voice)]: event.target.value,
              })
            }
          />
          <small>
            仅保存到本机，按服务、模型和音色分别记录；发送给模型的仍是原音色
            ID。
          </small>
        </label>
        {voiceReady && audition?.assetId ? (
          <>
            <p className="field-hint">
              当前音色与参数已有录音，播放已保存音频无需再次生成。
            </p>
            <AudioPreview key={audition.assetId} versionId={audition.assetId} />
            <details>
              <summary>这段录音的文本</summary>
              <p className="speech-text">{audition.request.input}</p>
            </details>
          </>
        ) : (
          <p className="field-hint">选中任意音色后，可生成下面的短句试听。</p>
        )}
        <p className="field-hint">{auditionText}</p>
        <button
          className="small-button"
          disabled={
            !isDesktop ||
            busy ||
            active ||
            !hasKey ||
            !voiceReady ||
            settings.instructions.length > 4096
          }
          onClick={() => void run(() => generate(auditionText))}
        >
          {active
            ? '配音生成中…'
            : audition
              ? '重新生成短句试听（计费）'
              : '生成短句试听（计费）'}
        </button>
        <small className="field-hint">
          生成试听会调用当前模型并计入项目预算，使用上方预留金额；试听保留为独立音频版本，旁白文本和时间线配音保持原样。
        </small>
      </section>
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
          settings.instructions.length > 4096 ||
          !voiceReady ||
          !settings.model.trim()
        }
        onClick={() => void run(() => generate())}
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
                {job.request.instructions && (
                  <p>朗读要求：{job.request.instructions}</p>
                )}
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
