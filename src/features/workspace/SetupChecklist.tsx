import { useEffect, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import {
  errorMessage,
  listProviders,
  testProvider,
} from '@/features/workflow/api'
import * as media from '@/features/workflow/mediaApi'
import type { Provider } from '@/features/workflow/model'

interface Snapshot {
  providers: Provider[]
  comfyUrl: string
  cloudKey: boolean
  videoSingaporeKey: boolean
  videoBeijingKey: boolean
  tools: media.ExportToolsStatus | null
  failed: string[]
}

interface Check {
  ok: boolean
  message: string
}

const collapsedKey = 'frame-studio.setup.collapsed.v1'
function initiallyExpanded(): boolean {
  try {
    return localStorage.getItem(collapsedKey) !== 'yes'
  } catch {
    return true
  }
}

async function readSnapshot(): Promise<Snapshot> {
  const results = await Promise.allSettled([
    listProviders(),
    media.imageSettings(),
    media.cloudImageKeyStatus(),
    media.videoKeyStatus('singapore'),
    media.videoKeyStatus('beijing'),
    media.checkExportTools(),
  ] as const)
  const labels = [
    '文本连接',
    'ComfyUI 配置',
    '图片密钥',
    '新加坡视频密钥',
    '北京视频密钥',
    '导出工具',
  ]
  const failed = results.flatMap((result, index) =>
    result.status === 'rejected' ? [labels[index] ?? '未知状态'] : [],
  )
  return {
    providers: results[0].status === 'fulfilled' ? results[0].value : [],
    comfyUrl:
      results[1].status === 'fulfilled'
        ? (results[1].value?.baseUrl ?? 'http://127.0.0.1:8188')
        : 'http://127.0.0.1:8188',
    cloudKey: results[2].status === 'fulfilled' && results[2].value,
    videoSingaporeKey: results[3].status === 'fulfilled' && results[3].value,
    videoBeijingKey: results[4].status === 'fulfilled' && results[4].value,
    tools: results[5].status === 'fulfilled' ? results[5].value : null,
    failed,
  }
}

export function SetupChecklist({
  onModels,
  onImages,
  onVideos,
  onTimeline,
}: {
  onModels: () => void
  onImages: () => void
  onVideos: () => void
  onTimeline: () => void
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const [refreshing, setRefreshing] = useState(false)
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [textCheck, setTextCheck] = useState<Check | null>(null)
  const [comfyCheck, setComfyCheck] = useState<Check | null>(null)
  const [checking, setChecking] = useState<'text' | 'comfy' | null>(null)
  useEffect(() => {
    if (!isDesktop) return
    let active = true
    void readSnapshot().then((value) => {
      if (active) setSnapshot(value)
    })
    return () => {
      active = false
    }
  }, [])
  async function refresh() {
    setRefreshing(true)
    try {
      setSnapshot(await readSnapshot())
      setTextCheck(null)
      setComfyCheck(null)
    } finally {
      setRefreshing(false)
    }
  }
  async function checkText() {
    const id = selectedProviderId || snapshot?.providers[0]?.id
    if (!id) return
    setChecking('text')
    try {
      const message = await testProvider(id)
      setTextCheck({ ok: message.includes('已找到配置的模型'), message })
    } catch (reason) {
      setTextCheck({ ok: false, message: errorMessage(reason) })
    } finally {
      setChecking(null)
    }
  }
  async function checkComfy() {
    setChecking('comfy')
    try {
      const checkpoints = await media.testComfy(
        snapshot?.comfyUrl ?? 'http://127.0.0.1:8188',
      )
      setComfyCheck({
        ok: checkpoints.length > 0,
        message: checkpoints.length
          ? `服务可连接，发现 ${checkpoints.length} 个 checkpoint；模型是否兼容将在生成时验证。`
          : '服务可连接，但未发现 checkpoint。请安装模型后再试。',
      })
    } catch (reason) {
      setComfyCheck({ ok: false, message: errorMessage(reason) })
    } finally {
      setChecking(null)
    }
  }
  const providers = snapshot?.providers ?? []
  const loading = isDesktop && !snapshot
  const textReady = textCheck?.ok ?? false
  const imageReady = comfyCheck?.ok ?? false
  const videoKeys = [
    snapshot?.videoSingaporeKey && '新加坡',
    snapshot?.videoBeijingKey && '北京',
  ].filter(Boolean)
  function toggleExpanded() {
    const next = !expanded
    setExpanded(next)
    try {
      localStorage.setItem(collapsedKey, next ? 'no' : 'yes')
    } catch {
      // The guide remains usable when preference storage is unavailable.
    }
  }
  return (
    <section
      className={`setup-guide ${expanded ? '' : 'collapsed'}`}
      aria-labelledby="setup-title"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">GET STARTED</p>
          <h2 id="setup-title">开始制作前，检查创作工具</h2>
        </div>
        <div className="setup-heading-actions">
          {expanded && (
            <button
              className="button subtle"
              onClick={() => void refresh()}
              disabled={!isDesktop || refreshing}
            >
              {refreshing ? '正在刷新…' : '刷新准备状态'}
            </button>
          )}
          <button className="button subtle" onClick={toggleExpanded}>
            {expanded ? '收起引导' : '展开引导'}
          </button>
        </div>
      </div>
      {expanded && (
        <>
          <p className="setup-intro">
            文本、图片、视频和导出可以逐步配置；检测只读取服务状态，不提交生成任务。
          </p>
          {!isDesktop && (
            <p className="workflow-notice">
              浏览器预览展示配置步骤。连接和本机工具检测请在桌面应用中进行。
            </p>
          )}
          {!!snapshot?.failed.length && (
            <p className="workflow-error">
              以下状态读取失败：{snapshot.failed.join('、')}。可刷新后重试。
            </p>
          )}
          <div className="setup-grid">
            <article className="setup-card">
              <div className="setup-card-head">
                <span>01 / 文本</span>
                <b className={textReady ? 'setup-good' : ''}>
                  {!isDesktop
                    ? '仅预览'
                    : loading
                      ? '读取中'
                      : textReady
                        ? '已验证'
                        : textCheck
                          ? '需核对'
                          : providers.length
                            ? '待检测'
                            : '未配置'}
                </b>
              </div>
              <h3>故事与分镜</h3>
              <p>
                {loading
                  ? '正在读取已保存的文本连接…'
                  : (textCheck?.message ??
                    (providers.length
                      ? `已保存 ${providers.length} 个文本连接。检测会核对所选模型 ID。`
                      : '添加 Ollama 或 OpenAI 兼容文本连接。'))}
              </p>
              {providers.length > 1 && (
                <select
                  aria-label="要检测的文本连接"
                  value={selectedProviderId || providers[0]?.id}
                  onChange={(event) => {
                    setSelectedProviderId(event.target.value)
                    setTextCheck(null)
                  }}
                >
                  {providers.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name} · {provider.model}
                    </option>
                  ))}
                </select>
              )}
              <div className="setup-actions">
                <button className="small-button" onClick={onModels}>
                  配置文本模型
                </button>
                <button
                  className="text-button"
                  disabled={
                    !isDesktop || !providers.length || checking !== null
                  }
                  onClick={() => void checkText()}
                >
                  {checking === 'text' ? '检测中…' : '检测模型'}
                </button>
              </div>
            </article>
            <article className="setup-card">
              <div className="setup-card-head">
                <span>02 / 图片</span>
                <b className={imageReady ? 'setup-good' : ''}>
                  {!isDesktop
                    ? '仅预览'
                    : loading
                      ? '读取中'
                      : imageReady
                        ? '本机已验证'
                        : comfyCheck
                          ? '需核对'
                          : snapshot?.cloudKey
                            ? '云端密钥已保存'
                            : '待配置'}
                </b>
              </div>
              <h3>首帧生成</h3>
              <p>
                {loading
                  ? '正在读取图片服务配置…'
                  : (comfyCheck?.message ??
                    (snapshot?.cloudKey
                      ? '云端图片密钥已保存，尚未验证模型权限；也可检测本机 ComfyUI。'
                      : `检测本机 ComfyUI（${snapshot?.comfyUrl ?? '127.0.0.1:8188'}），或配置云端图片密钥。`))}
              </p>
              <div className="setup-actions">
                <button className="small-button" onClick={onImages}>
                  打开首帧设置
                </button>
                <button
                  className="text-button"
                  disabled={!isDesktop || checking !== null}
                  onClick={() => void checkComfy()}
                >
                  {checking === 'comfy' ? '检测中…' : '检测 ComfyUI'}
                </button>
              </div>
            </article>
            <article className="setup-card">
              <div className="setup-card-head">
                <span>03 / 视频</span>
                <b>
                  {!isDesktop
                    ? '仅预览'
                    : loading
                      ? '读取中'
                      : videoKeys.length
                        ? '密钥已保存'
                        : '未配置'}
                </b>
              </div>
              <h3>镜头视频</h3>
              <p>
                {loading
                  ? '正在读取视频密钥状态…'
                  : videoKeys.length
                    ? `${videoKeys.join('、')}地区密钥已保存，尚未验证服务权限。`
                    : '配置视频服务地区和密钥，再逐镜头生成片段。'}
              </p>
              <div className="setup-actions">
                <button className="small-button" onClick={onVideos}>
                  配置视频服务
                </button>
              </div>
            </article>
            <article className="setup-card">
              <div className="setup-card-head">
                <span>04 / 导出</span>
                <b className={snapshot?.tools?.ready ? 'setup-good' : ''}>
                  {!isDesktop
                    ? '仅预览'
                    : loading
                      ? '检测中'
                      : snapshot?.tools?.ready
                        ? '已验证'
                        : snapshot?.tools
                          ? '需修复'
                          : '待检测'}
                </b>
              </div>
              <h3>本机 MP4 合成</h3>
              <p>
                {snapshot?.tools?.message ??
                  (isDesktop
                    ? '正在检测 FFmpeg 与 FFprobe…'
                    : '桌面应用中检测 FFmpeg 与 FFprobe。')}
              </p>
              <div className="setup-actions">
                <button className="small-button" onClick={onTimeline}>
                  打开时间线
                </button>
              </div>
            </article>
          </div>
        </>
      )}
    </section>
  )
}
