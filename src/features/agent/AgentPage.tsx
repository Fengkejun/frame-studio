import { useEffect, useRef, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import * as workflowApi from '../workflow/api'
import * as media from '../workflow/mediaApi'
import type { Provider, Workflow } from '../workflow/model'
import { withSavedVideoSettings } from '../workflow/videoPreferences'
import { AssetImage } from '../workflow/AssetImage'
import { AgentSettings } from './AgentSettings'
import { SkillsPanel } from './SkillsPanel'
import * as api from './api'
import './agent.css'

function defaultConfig(providers: Provider[]): api.Config {
  const saved = withSavedVideoSettings({
    context: {
      workflowId: 'agent',
      nodeId: 'agent',
      artifactId: 'agent',
      shotId: 'agent',
    },
    firstFrameVersionId: '',
    region: 'singapore',
    resolution: '720P',
    duration: 12,
    prompt: '',
    negativePrompt: '',
  })
  return {
    providerId: providers[0]?.id ?? '',
    video: {
      region: saved.region,
      resolution: saved.resolution,
      wulusai: saved.wulusai ?? null,
    },
    image: null,
    budgetMicroUsd: 2000000,
    autoSearchSkills: true,
  }
}
const statusNames: Record<string, string> = {
  running: '制作中',
  stopping: '正在停止',
  succeeded: '已完成',
  paused: '需要处理',
  stopped: '已停止',
  interrupted: '已中断',
}
export function AgentPage({
  onModels,
  onCanvas,
  modelsRevision,
}: {
  onModels: () => void
  onCanvas: (id?: string) => void
  modelsRevision: number
}) {
  const [providers, setProviders] = useState<Provider[]>([])
  const [config, setConfig] = useState<api.Config>(() => defaultConfig([]))
  const [sessions, setSessions] = useState<api.Session[]>([])
  const [selected, setSelected] = useState('')
  const [goal, setGoal] = useState(() => {
    try {
      return (localStorage.getItem('frame-studio.agent-draft') ?? '').slice(
        0,
        5000,
      )
    } catch {
      return ''
    }
  })
  const [referenceId, setReferenceId] = useState<string | null>(null)
  const [scriptOnly, setScriptOnly] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showSkills, setShowSkills] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [workflow, setWorkflow] = useState<Workflow | null>(null)
  const [videoPreview, setVideoPreview] = useState<{
    versionId: string
    url: string
  } | null>(null)
  const conversation = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const current = sessions.find((s) => s.id === selected)
  const active = sessions.some(api.running)
  const reference = referenceId ?? current?.referenceVersionId ?? null
  useEffect(() => {
    try {
      localStorage.setItem('frame-studio.agent-draft', goal)
    } catch {
      /* Keep the editor usable if preferences are blocked. */
    }
  }, [goal])
  useEffect(() => {
    let alive = true
    void Promise.all([
      workflowApi.listProviders(),
      api.getConfig(),
      api.listSessions(),
    ])
      .then(([providers, saved, sessions]) => {
        if (!alive) return
        setProviders(providers)
        setConfig(saved ?? defaultConfig(providers))
        setSessions(sessions)
        setSelected((previous) => previous || sessions[0]?.id || '')
      })
      .catch((e) => {
        if (alive) setError(workflowApi.errorMessage(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [modelsRevision])
  const pollingIds = sessions
    .filter(api.running)
    .map((s) => s.id)
    .join(',')
  useEffect(() => {
    if (!pollingIds) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      try {
        const next = await Promise.all(
          pollingIds.split(',').map(api.getSession),
        )
        if (!disposed)
          setSessions((old) =>
            old.map((s) => next.find((n) => n.id === s.id) ?? s),
          )
      } catch (e) {
        if (!disposed) setError(workflowApi.errorMessage(e))
      }
      if (!disposed) timer = setTimeout(() => void poll(), 1000)
    }
    timer = setTimeout(() => void poll(), 500)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [pollingIds])
  useEffect(() => {
    let alive = true
    if (!current?.workflowId) return
    void workflowApi
      .listWorkflows()
      .then((items) => {
        if (alive)
          setWorkflow(items.find((w) => w.id === current.workflowId) ?? null)
      })
      .catch((e) => {
        if (alive) setError(workflowApi.errorMessage(e))
      })
    return () => {
      alive = false
    }
  }, [current?.workflowId, current?.updatedAt])
  useEffect(() => {
    let alive = true
    if (current?.videoVersionId)
      void media
        .videoPreview(current.videoVersionId)
        .then((url) => {
          if (alive)
            setVideoPreview({ versionId: current.videoVersionId!, url })
        })
        .catch((e) => {
          if (alive) setError(workflowApi.errorMessage(e))
        })
    return () => {
      alive = false
    }
  }, [current?.videoVersionId])
  useEffect(() => {
    if (conversation.current && api.running(current))
      conversation.current.scrollTop = conversation.current.scrollHeight
  }, [current?.events.length, current])
  function newCreation() {
    setSelected('')
    setGoal('')
    setReferenceId(null)
    setWorkflow(null)
    setError('')
    setNotice('')
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(workflowApi.errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  async function start() {
    await action(async () => {
      const s = await api.start({
        goal,
        config,
        referenceVersionId: reference || null,
        parentId: current?.id ?? null,
        scriptOnly,
      })
      setSessions((old) => [s, ...old.filter((item) => item.id !== s.id)])
      setSelected(s.id)
      setGoal('')
      setReferenceId(null)
      setNotice('')
    })
  }
  const videoUrl =
    videoPreview?.versionId === current?.videoVersionId ? videoPreview?.url : ''
  const currentWorkflow = workflow?.id === current?.workflowId ? workflow : null
  const story = currentWorkflow?.nodes.find((n) => n.kind === 'story')?.output
    ?.value
  const board = currentWorkflow?.nodes.find((n) => n.kind === 'storyboard')
    ?.output?.value
  const configuredText = providers.find((p) => p.id === config.providerId)
  return (
    <div className="agent-workspace">
      <aside className="agent-history" aria-label="创作会话">
        <div className="agent-history-title">
          <span>灵感与作品</span>
          <button
            className="small-button"
            onClick={newCreation}
            aria-label="新建 Agent 创作"
          >
            ＋
          </button>
        </div>
        {!sessions.length && (
          <p className="agent-history-empty">每一次灵感，都在这里继续。</p>
        )}
        {sessions.map((s) => (
          <button
            key={s.id}
            className={`agent-history-item ${selected === s.id ? 'selected' : ''}`}
            onClick={() => {
              setSelected(s.id)
              setReferenceId(null)
              setError('')
              setNotice('')
            }}
          >
            <strong>{s.plan?.title ?? s.request.goal}</strong>
            <small>
              <span className={api.running(s) ? 'agent-live-dot' : ''} />
              {statusNames[s.status] ?? s.status} ·{' '}
              {new Date(s.createdAt).toLocaleDateString()}
            </small>
          </button>
        ))}
        <div className="agent-history-foot">
          项目与媒体保存在本机
          <br />
          模型密钥存入系统凭据库
        </div>
      </aside>
      <section className="agent-main">
        <header className="agent-topline">
          <div>
            <span className="agent-wordmark">FRAME / DIRECTOR</span>
            <strong>灵感创作</strong>
          </div>
          <div className="agent-actions">
            <button
              className="small-button"
              onClick={() => setShowSettings(true)}
            >
              模型设置
            </button>
            <button
              className="small-button"
              onClick={() => setShowSkills(true)}
            >
              技能库
            </button>
            <button
              className="text-button"
              onClick={() => onCanvas(current?.workflowId)}
            >
              高级画布 ↗
            </button>
          </div>
        </header>
        <div className="agent-conversation" ref={conversation}>
          {!current ? (
            <div className="agent-welcome">
              <div className="agent-aperture" aria-hidden="true">
                ✦
              </div>
              <p className="agent-overline">让想象，成为下一帧</p>
              <h1>告诉我，你想讲一个怎样的故事？</h1>
              <p>
                一句创作需求，或一张参考图。
                <br />
                我来安排剧本、分镜和生成工具，把它拍成动漫短片。
              </p>
              <div className="agent-examples">
                {[
                  '一个雨夜，少女邮差给屋顶的小猫送来一封发光的信，做成12秒治愈动漫。',
                  '创作一段小机器人第一次看见日出的温暖故事，先帮我写剧本和分镜。',
                ].map((text, i) => (
                  <button
                    key={text}
                    onClick={() => {
                      setGoal(text)
                      setScriptOnly(i === 1)
                    }}
                  >
                    {i === 0 ? '✧ 治愈动漫短片' : '✎ 先打磨一个故事'}
                    <span>{text}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="agent-thread">
              <article className="agent-user-message">
                <p>{current.request.goal}</p>
                {current.request.referenceVersionId && (
                  <AssetImage
                    versionId={current.request.referenceVersionId}
                    alt="本次创作参考图"
                  />
                )}
              </article>
              {current.plan && (
                <article className="agent-plan">
                  <small>导演的制作计划</small>
                  <h2>{current.plan.title}</h2>
                  <p>{current.plan.summary}</p>
                  <div className="agent-plan-facts">
                    <span>剧本 {current.plan.storyDuration} 秒</span>
                    <span>
                      {current.plan.steps.includes('generate_video')
                        ? '本次视频'
                        : '分镜段落'}{' '}
                      {current.plan.duration} 秒
                    </span>
                    <span>{current.plan.shotCount} 个分镜</span>
                    <span>
                      {current.plan.generationMode === 'frame'
                        ? '使用参考首帧'
                        : '连续文生视频'}
                    </span>
                  </div>
                  {current.plan.steps.includes('generate_video') &&
                    current.plan.storyDuration > current.plan.duration && (
                      <p className="agent-scope-note">
                        完整剧本 {current.plan.storyDuration}{' '}
                        秒，本次仅制作第一段 {current.plan.duration}{' '}
                        秒；长片尚需后续段落与衔接制作。
                      </p>
                    )}
                </article>
              )}
              <details className="agent-progress" open={api.running(current)}>
                <summary>
                  <span
                    className={api.running(current) ? 'agent-live-dot' : ''}
                  />
                  {statusNames[current.status] ?? current.status} · 查看工具调用
                </summary>
                <ol>
                  {current.events.map((event, i) => (
                    <li key={i} data-state={event.status}>
                      <span>
                        {event.status === 'succeeded'
                          ? '✓'
                          : event.status === 'running'
                            ? '◌'
                            : '·'}
                      </span>
                      <div>
                        <strong>
                          {api.toolNames[event.tool] ?? event.tool}
                        </strong>
                        <p>{event.message}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </details>
              {story && 'content' in story && (
                <details
                  className="agent-artifact"
                  open={
                    !current.plan?.steps.includes('generate_video') &&
                    current.status === 'succeeded'
                  }
                >
                  <summary>✎ 查看完整剧本 · {story.title}</summary>
                  <p>{story.logline}</p>
                  <div className="agent-script">{story.content}</div>
                </details>
              )}
              {board && 'shots' in board && (
                <details className="agent-artifact">
                  <summary>▤ 查看分镜 · {board.shots.length} 个镜头</summary>
                  {board.shots.map((shot, i) => (
                    <article className="agent-shot" key={shot.id}>
                      <small>
                        {String(i + 1).padStart(2, '0')} / {shot.duration}秒 ·{' '}
                        {shot.camera}
                      </small>
                      <h3>{shot.title}</h3>
                      <p>{shot.description}</p>
                      {shot.dialogue && (
                        <blockquote>{shot.dialogue}</blockquote>
                      )}
                    </article>
                  ))}
                </details>
              )}
              {videoUrl && (
                <article className="agent-video-result">
                  <div>
                    <span>▸</span>
                    <h2>
                      {current.status === 'succeeded'
                        ? '你的短片已就绪'
                        : '候选视频 · 需要审看'}
                    </h2>
                  </div>
                  <video
                    controls
                    playsInline
                    src={videoUrl}
                    aria-label="Agent 生成视频"
                  />
                  <p>
                    保留模型原始画面与声音；播放后可继续提出修改，或进入高级画布调整字幕和配音。
                  </p>
                  <div className="agent-actions">
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          const path = await media.chooseExportPath()
                          if (path) {
                            await media.saveVideoCopy(
                              current.videoVersionId!,
                              path,
                            )
                            setNotice(`已保存：${path}`)
                          }
                        })
                      }
                    >
                      另存 MP4
                    </button>
                    <button
                      className="small-button"
                      onClick={() => onCanvas(current.workflowId)}
                    >
                      编辑这个项目 ↗
                    </button>
                  </div>
                </article>
              )}
              {!api.running(current) && current.status !== 'succeeded' && (
                <article className="agent-attention">
                  <h3>这一步需要处理</h3>
                  <p>{current.message}</p>
                  <div className="agent-actions">
                    <button
                      className="small-button"
                      onClick={() => setShowSettings(true)}
                    >
                      检查模型配置
                    </button>
                    {current.videoJobId && (
                      <button
                        className="small-button"
                        disabled={busy || active}
                        onClick={() =>
                          void action(async () => {
                            const s = await api.resume(current.id)
                            setSessions((items) =>
                              items.map((item) =>
                                item.id === s.id ? s : item,
                              ),
                            )
                          })
                        }
                      >
                        继续查询原视频任务
                      </button>
                    )}
                  </div>
                  <small>
                    已完成的剧本、分镜和素材保留。生成结果未知时，请核对服务记录后再决定是否重新制作。
                  </small>
                </article>
              )}
            </div>
          )}
        </div>
        <div className="agent-composer-wrap">
          {error && (
            <p className="agent-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="agent-notice" role="status">
              {notice}
            </p>
          )}
          {!isDesktop && (
            <p className="agent-notice">
              当前为界面预览，请在桌面应用中自动调用模型。
            </p>
          )}
          {!configuredText && !loading && (
            <p className="agent-notice">
              先连接一个文本模型，就能让 Agent 理解和规划你的创作。
              <button className="text-button" onClick={onModels}>
                配置模型 ↗
              </button>
            </p>
          )}
          <form
            className="agent-composer"
            onSubmit={(e) => {
              e.preventDefault()
              void start()
            }}
          >
            {reference && (
              <div className="agent-reference">
                <AssetImage versionId={reference} alt="待使用的角色参考图" />
                <span>参考图将用于首帧图生模式</span>
                <button
                  type="button"
                  aria-label="移除创作参考图"
                  onClick={() => setReferenceId('')}
                >
                  ✕
                </button>
              </div>
            )}
            <textarea
              aria-label="告诉 Agent 你的创作需求"
              placeholder={
                current
                  ? '继续告诉我你的修改要求，新版本会保留原作品…'
                  : '描述想要的动漫故事、人物与风格，Agent 会规划并调用创作工具…'
              }
              value={goal}
              maxLength={5000}
              rows={3}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => {
                if (
                  (e.ctrlKey || e.metaKey) &&
                  e.key === 'Enter' &&
                  !busy &&
                  !active &&
                  isDesktop &&
                  goal.trim() &&
                  configuredText
                ) {
                  e.preventDefault()
                  void start()
                }
              }}
            />
            <div className="agent-composer-bar">
              <div className="agent-actions">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  aria-label="上传 Agent 参考图"
                  hidden
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file)
                      void action(async () =>
                        setReferenceId(
                          (await media.importImage(file)).versionId,
                        ),
                      )
                    e.target.value = ''
                  }}
                />
                <button
                  type="button"
                  className="agent-add"
                  title="添加参考图"
                  aria-label="添加创作参考图"
                  disabled={!isDesktop || busy}
                  onClick={() => fileInput.current?.click()}
                >
                  ＋
                </button>
                <select
                  aria-label="Agent 创作模式"
                  value={scriptOnly ? 'script' : 'auto'}
                  onChange={(e) => setScriptOnly(e.target.value === 'script')}
                >
                  <option value="auto">✦ 自动制作视频</option>
                  <option value="script">✎ 先写剧本与分镜</option>
                </select>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setShowSkills(true)}
                >
                  技能 · 自动
                </button>
              </div>
              <div className="agent-send">
                <small>{goal.length}/5000</small>
                {active ? (
                  <button
                    type="button"
                    className="small-button"
                    disabled={busy}
                    onClick={() =>
                      void action(() =>
                        api.stop(sessions.find(api.running)!.id),
                      )
                    }
                  >
                    停止自动制作
                  </button>
                ) : (
                  <button
                    className="button primary"
                    disabled={
                      !isDesktop ||
                      loading ||
                      busy ||
                      !goal.trim() ||
                      !configuredText
                    }
                  >
                    {busy
                      ? '正在启动…'
                      : scriptOnly
                        ? '开始创作剧本'
                        : '开始自动制作 ↑'}
                  </button>
                )}
              </div>
            </div>
          </form>
          <p className="agent-composer-caption">
            {configuredText
              ? `${configuredText.name} · ${configuredText.model}`
              : '配置一次模型，后续自动调用'}{' '}
            · 媒体预算预留上限 ${(config.budgetMicroUsd / 1000000).toFixed(2)} /
            次 · Ctrl / ⌘ + Enter 发送
          </p>
        </div>
      </section>
      {showSettings && (
        <AgentSettings
          config={config}
          providers={providers}
          onSave={setConfig}
          onClose={() => setShowSettings(false)}
          onModels={onModels}
        />
      )}
      {showSkills && <SkillsPanel onClose={() => setShowSkills(false)} />}
    </div>
  )
}
