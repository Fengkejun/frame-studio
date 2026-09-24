import { useEffect, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { listen } from '@tauri-apps/api/event'
import * as api from './api'
import type { Provider } from './model'

function blank(): Provider {
  return {
    id: crypto.randomUUID(),
    name: '',
    kind: 'ollama',
    baseUrl: 'http://localhost:11434/api',
    model: '',
    hasKey: false,
  }
}
export function ConnectionsPage({
  onChanged,
  busy,
}: {
  onChanged: () => void
  busy: boolean
}) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [form, setForm] = useState(blank)
  const [key, setKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [models, setModels] = useState<api.OllamaModel[]>([])
  const [pulling, setPulling] = useState(false)
  const [pullProgress, setPullProgress] =
    useState<api.OllamaPullProgress | null>(null)
  useEffect(() => {
    api
      .listProviders()
      .then(setProviders)
      .catch((e: unknown) => setError(api.errorMessage(e)))
  }, [])
  useEffect(() => {
    if (!isDesktop) return
    let alive = true
    const listeners: Array<() => void> = []
    void (async () => {
      const onProgress = await listen<api.OllamaPullProgress>(
        'ollama-pull-progress',
        (event) => {
          if (alive) setPullProgress(event.payload)
        },
      )
      if (!alive) return onProgress()
      listeners.push(onProgress)
      const onFinished = await listen<string>(
        'ollama-pull-finished',
        (event) => {
          if (!alive) return
          setPulling(false)
          if (event.payload === 'success')
            setMessage('模型下载完成。刷新已安装模型后即可选择。')
          else setError('模型下载未完成。请刷新已安装模型核实状态。')
        },
      )
      if (!alive) return onFinished()
      listeners.push(onFinished)
      const active = await api.getOllamaPull()
      if (alive && active) {
        setPulling(true)
        setPullProgress(active)
      }
    })().catch((e: unknown) => {
      if (alive) setError(api.errorMessage(e))
    })
    return () => {
      alive = false
      listeners.forEach((unlisten) => unlisten())
    }
  }, [])
  const locked = !isDesktop || pending || pulling || busy
  const exists = providers.some((p) => p.id === form.id)
  function edit(p: Provider) {
    setForm(p)
    setKey('')
    setClearKey(false)
    setMessage('')
    setError('')
    setDeleting(false)
    setModels([])
    setPullProgress(null)
  }
  async function refreshModels() {
    setPending(true)
    setError('')
    try {
      const installed = await api.listOllamaModels(form.baseUrl)
      setModels(installed)
      setMessage(
        installed.length
          ? `找到 ${installed.length} 个已安装模型。点击名称可填入模型 ID。`
          : 'Ollama 已连接，尚未安装模型。',
      )
    } catch (e) {
      setError(api.errorMessage(e))
    } finally {
      setPending(false)
    }
  }
  async function pullModel() {
    setPulling(true)
    setError('')
    setMessage('正在从 Ollama 下载模型；下载大小取决于所选模型。')
    setPullProgress(null)
    try {
      await api.pullOllamaModel(form.baseUrl, form.model)
      const installed = await api.listOllamaModels(form.baseUrl)
      setModels(installed)
      setMessage('模型下载完成。保存连接后即可在画布中使用。')
    } catch (e) {
      setError(api.errorMessage(e))
    } finally {
      setPulling(false)
    }
  }
  async function save() {
    setPending(true)
    setError('')
    setMessage('')
    try {
      const saved = await api.saveProvider(form, key, clearKey)
      setProviders((items) => [
        ...items.filter((p) => p.id !== saved.id),
        saved,
      ])
      setForm(saved)
      setKey('')
      setClearKey(false)
      onChanged()
      setMessage('连接已保存。可测试连接，再到画布为 Agent 选择模型。')
    } catch (e) {
      setError(api.errorMessage(e))
    } finally {
      setPending(false)
    }
  }
  async function test() {
    setPending(true)
    setError('')
    setMessage('')
    try {
      setMessage(await api.testProvider(form.id))
    } catch (e) {
      setError(api.errorMessage(e))
    } finally {
      setPending(false)
    }
  }
  async function remove() {
    if (!deleting) {
      setDeleting(true)
      return
    }
    setPending(true)
    try {
      await api.removeProvider(form.id)
      setProviders((items) => items.filter((p) => p.id !== form.id))
      edit(blank())
      onChanged()
    } catch (e) {
      setError(api.errorMessage(e))
    } finally {
      setPending(false)
    }
  }
  const dirty =
    exists &&
    JSON.stringify(providers.find((p) => p.id === form.id)) !==
      JSON.stringify(form)
  return (
    <div className="connections-page">
      <p className="eyebrow">MODEL CONNECTIONS</p>
      <h1>让每位 Agent 找到合适的模型。</h1>
      <p className="section-description">
        连接本机 Ollama 或兼容 OpenAI Chat Completions 的文本服务。模型 ID
        按服务商提供的名称填写。
      </p>
      {!isDesktop && (
        <p className="workflow-notice">
          浏览器可预览配置界面。保存密钥和调用模型，请使用桌面应用。
        </p>
      )}
      {busy && (
        <p className="workflow-notice">任务执行中，模型连接暂时只读。</p>
      )}
      <div className="connections-layout">
        <section className="connection-list" aria-label="已保存的模型连接">
          <div className="panel-heading">
            <h2>我的连接</h2>
            <button
              className="small-button"
              onClick={() => edit(blank())}
              disabled={locked}
            >
              ＋ 新建
            </button>
          </div>
          {providers.length === 0 && (
            <p className="empty-copy">
              还没有连接。先配置一个文本模型，就能开始生成故事。
            </p>
          )}
          {providers.map((p) => (
            <button
              key={p.id}
              className={`connection-item ${form.id === p.id ? 'selected' : ''}`}
              onClick={() => edit(p)}
              disabled={pending || pulling}
            >
              <span className="connection-icon">
                {p.kind === 'ollama' ? '⌂' : '↗'}
              </span>
              <span>
                <strong>{p.name}</strong>
                <small>{p.model}</small>
              </span>
              <span className="connection-type">
                {p.kind === 'ollama' ? 'Ollama' : 'API'}
              </span>
            </button>
          ))}
          <div className="connection-roadmap">
            <span className="eyebrow">MEDIA CONNECTIONS</span>
            <p>图片与视频服务</p>
            <small>
              ComfyUI 和 OpenAI 图片生成在「首帧与素材」中配置；Wan
              镜头视频在「镜头视频」中配置。
            </small>
          </div>
        </section>
        <section className="connection-editor">
          <div className="panel-heading">
            <h2>{exists ? '编辑连接' : '添加模型连接'}</h2>
            <span className="badge">文本能力</span>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void save()
            }}
          >
            <fieldset disabled={locked} className="plain-fieldset">
              <label className="field">
                连接名称
                <input
                  value={form.name}
                  maxLength={100}
                  required
                  placeholder="例如：本地编剧 / 云端分镜"
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label className="field">
                接入方式
                <select
                  value={form.kind}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      kind: e.target.value as Provider['kind'],
                      baseUrl:
                        e.target.value === 'ollama'
                          ? 'http://localhost:11434/api'
                          : 'https://api.openai.com/v1',
                    })
                  }
                >
                  <option value="ollama">Ollama 本地服务</option>
                  <option value="openai">OpenAI 兼容接口</option>
                </select>
              </label>
              <label className="field">
                API 根地址
                <input
                  value={form.baseUrl}
                  type="url"
                  required
                  onChange={(e) => {
                    setForm({ ...form, baseUrl: e.target.value })
                    setModels([])
                  }}
                />
                <small>
                  {form.kind === 'ollama'
                    ? '包含 /api，不要附加 /chat。请先启动 Ollama 并下载模型。'
                    : '通常以 /v1 结尾，不要附加 /chat/completions。云端使用 HTTPS。'}
                </small>
              </label>
              <label className="field">
                模型 ID
                <input
                  value={form.model}
                  maxLength={200}
                  required
                  placeholder="填写已安装或已开通的模型名称"
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                />
              </label>
              {form.kind === 'ollama' && (
                <div className="ollama-model-tools">
                  <div className="form-actions">
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => void refreshModels()}
                    >
                      刷新已安装模型
                    </button>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={!form.model.trim() || pulling}
                      onClick={() => void pullModel()}
                    >
                      下载当前模型 ID
                    </button>
                  </div>
                  {models.length > 0 && (
                    <div
                      className="model-choices"
                      aria-label="已安装的 Ollama 模型"
                    >
                      {models.map((model) => (
                        <button
                          className="small-button"
                          type="button"
                          key={model.name}
                          onClick={() =>
                            setForm({ ...form, model: model.name })
                          }
                        >
                          {model.name} · {(model.size / 1024 ** 3).toFixed(1)}{' '}
                          GB
                        </button>
                      ))}
                    </div>
                  )}
                  {pullProgress && (
                    <p className="field-hint" role="status">
                      {pullProgress.status}{' '}
                      {pullProgress.total > 0
                        ? `${Math.round((pullProgress.completed / pullProgress.total) * 100)}%`
                        : ''}
                    </p>
                  )}
                </div>
              )}
              <label className="field">
                API Key{' '}
                <span className="muted">
                  {form.hasKey ? '· 已存入系统凭据库' : '· 本地服务可留空'}
                </span>
                <input
                  value={key}
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  maxLength={4096}
                  placeholder={
                    form.hasKey ? '留空保留原密钥' : '输入服务商提供的密钥'
                  }
                  onChange={(e) => setKey(e.target.value)}
                />
              </label>
              {form.hasKey && (
                <label className="check-field">
                  <input
                    type="checkbox"
                    checked={clearKey}
                    onChange={(e) => setClearKey(e.target.checked)}
                  />
                  移除已保存的密钥
                </label>
              )}
              <p className="field-hint">
                密钥只存入系统凭据库，不会随工作流导出。连接测试读取模型列表，不发起生成。
              </p>
              <div className="form-actions">
                <button className="button primary" type="submit">
                  {pending ? '处理中…' : '保存连接'}
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={!exists || dirty || !!key || clearKey}
                  onClick={() => void test()}
                >
                  测试连接
                </button>
                {exists && (
                  <button
                    className="text-button danger"
                    type="button"
                    onClick={() => void remove()}
                  >
                    {deleting ? '确认删除连接与密钥' : '删除连接'}
                  </button>
                )}
              </div>
            </fieldset>
          </form>
          {pulling && (
            <button
              className="button secondary"
              type="button"
              onClick={() => void api.cancelOllamaPull()}
            >
              停止下载
            </button>
          )}
          {error && (
            <p className="workflow-error" role="alert">
              {error}
            </p>
          )}
          {message && (
            <p className="workflow-notice" role="status">
              {message}
            </p>
          )}
        </section>
      </div>
    </div>
  )
}
