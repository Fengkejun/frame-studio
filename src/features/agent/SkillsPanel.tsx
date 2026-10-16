import { useEffect, useRef, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from '../workflow/api'
import * as api from './api'
export function SkillsPanel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [skills, setSkills] = useState<api.Skill[]>([])
  const [query, setQuery] = useState('cinematography')
  const [repository, setRepository] = useState('fal-ai-community/skills')
  const [results, setResults] = useState<api.RemoteSkill[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    void api
      .listSkills()
      .then(setSkills)
      .catch((e) => setError(errorMessage(e)))
    return () => dialog.close()
  }, [])
  async function action(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await fn()
      setSkills(await api.listSkills())
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={ref}
      className="agent-dialog"
      onCancel={onClose}
      aria-label="Agent 技能库"
    >
      <header>
        <div>
          <small>本机知识与制作方法</small>
          <h2>创作技能库</h2>
        </div>
        <button onClick={onClose} aria-label="关闭技能库">
          ✕
        </button>
      </header>
      <p>
        Agent 会按需求加载已启用的技能。技能文档保存在应用数据目录 agent/skills
        中，来源与内容指纹一并保留。
      </p>
      <section className="agent-skills-list">
        {skills.map((s) => (
          <article key={s.id}>
            <label className="agent-check">
              <input
                type="checkbox"
                aria-label={`启用技能 ${s.name}`}
                checked={s.enabled}
                disabled={busy || !isDesktop}
                onChange={(e) =>
                  void action(() => api.toggleSkill(s.id, e.target.checked))
                }
              />
              <strong>{s.name}</strong>
            </label>
            <p>{s.description}</p>
            <small>{s.source}</small>
            <details>
              <summary>内容指纹</summary>
              <code>{s.sha256}</code>
            </details>
          </article>
        ))}
      </section>
      {!isDesktop && <p>请在桌面应用中管理和调用本机技能。</p>}
      <h3>联网搜索技能</h3>
      <p className="field-hint">
        搜索公开 GitHub 技能仓库中的
        SKILL.md。下载的文档作为创作指导，由本程序已接入的工具执行；依赖其他平台脚本的技能需要另行适配。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void action(async () =>
            setResults(await api.searchSkills(repository, query)),
          )
        }}
      >
        <label>
          技能仓库
          <input
            aria-label="技能仓库"
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            placeholder="owner/repository"
          />
        </label>
        <label>
          搜索词
          <input
            aria-label="技能搜索词"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="分镜、视频、cinematography"
          />
        </label>
        <button className="small-button" disabled={!isDesktop || busy}>
          {busy ? '正在处理…' : '搜索网络技能'}
        </button>
      </form>
      {results?.length === 0 && (
        <p>没有找到匹配的技能，可换一个英文关键词或仓库。</p>
      )}
      {results?.map((r) => (
        <article className="agent-skill-result" key={r.sha}>
          <div>
            <strong>{r.name}</strong>
            <small>
              {r.repository}/{r.path}
            </small>
          </div>
          <button
            className="small-button"
            disabled={busy || !isDesktop}
            onClick={() =>
              void action(async () => {
                await api.installSkill(r)
              })
            }
          >
            下载到本机
          </button>
        </article>
      ))}
      {error && (
        <p className="agent-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button className="button primary" onClick={onClose}>
          完成
        </button>
      </footer>
    </dialog>
  )
}
