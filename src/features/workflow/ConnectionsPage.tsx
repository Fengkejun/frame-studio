import { useEffect, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
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
  useEffect(() => {
    api
      .listProviders()
      .then(setProviders)
      .catch((e: unknown) => setError(api.errorMessage(e)))
  }, [])
  const locked = !isDesktop || pending || busy
  const exists = providers.some((p) => p.id === form.id)
  function edit(p: Provider) {
    setForm(p)
    setKey('')
    setClearKey(false)
    setMessage('')
    setError('')
    setDeleting(false)
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
              disabled={pending}
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
            <span className="eyebrow">NEXT CHAPTER</span>
            <p>图片与视频连接</p>
            <small>ComfyUI 与云端媒体适配器将在下一阶段接入。</small>
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
                  onChange={(e) =>
                    setForm({ ...form, baseUrl: e.target.value })
                  }
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
