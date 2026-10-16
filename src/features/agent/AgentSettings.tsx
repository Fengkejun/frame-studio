import { useEffect, useRef, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from '../workflow/api'
import type { Provider } from '../workflow/model'
import * as media from '../workflow/mediaApi'
import { VideoRelayFields } from '../workflow/VideoRelayFields'
import { getVideoModel, wanVideoModel } from '../workflow/videoModels'
import type { Config } from './api'
import * as api from './api'

export function AgentSettings({
  config,
  providers,
  onSave,
  onClose,
  onModels,
}: {
  config: Config
  providers: Provider[]
  onSave: (config: Config) => void
  onClose: () => void
  onModels: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [draft, setDraft] = useState(config)
  const [videoKey, setVideoKey] = useState('')
  const [imageKey, setImageKey] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [videoReady, setVideoReady] = useState(false)
  const [imageReady, setImageReady] = useState(false)
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => dialog.close()
  }, [])
  const v = draft.video
  const keyKind = v ? (v.wulusai ? 'relay' : 'wan') : 'none'
  const videoBase = v?.wulusai?.baseUrl
  const region = v?.region
  const imageBase = draft.image?.baseUrl
  useEffect(() => {
    let alive = true
    void Promise.all([
      keyKind === 'relay' && videoBase
        ? media.wulusaiVideoKeyStatus(videoBase)
        : keyKind === 'wan' && region
          ? media.videoKeyStatus(region)
          : Promise.resolve(false),
      imageBase ? media.cloudImageKeyStatus(imageBase) : Promise.resolve(false),
    ])
      .then(([video, image]) => {
        if (alive) {
          setVideoReady(video)
          setImageReady(image)
        }
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e))
      })
    return () => {
      alive = false
    }
  }, [keyKind, region, videoBase, imageBase])
  async function action(fn: () => Promise<void>) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const profile = v?.wulusai ? getVideoModel(v.wulusai.model) : wanVideoModel
  return (
    <dialog
      ref={ref}
      className="agent-dialog"
      onCancel={onClose}
      aria-label="Agent 模型设置"
    >
      <header>
        <div>
          <small>一次配置，后续自动调用</small>
          <h2>Agent 的创作工具</h2>
        </div>
        <button onClick={onClose} aria-label="关闭模型设置">
          ✕
        </button>
      </header>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void action(async () => {
            await api.saveConfig(draft)
            onSave(draft)
            onClose()
          })
        }}
      >
        <label>
          导演 / 文本模型
          <select
            aria-label="Agent 文本模型"
            value={draft.providerId}
            onChange={(e) => setDraft({ ...draft, providerId: e.target.value })}
          >
            <option value="">选择已配置的连接</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.model}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="text-button" onClick={onModels}>
          管理文本模型连接 ↗
        </button>
        <label>
          视频工具
          <select
            aria-label="Agent 视频服务"
            value={v?.wulusai ? 'relay' : v ? 'wan' : 'none'}
            onChange={(e) => {
              setVideoKey('')
              setVideoReady(false)
              setDraft({
                ...draft,
                video:
                  e.target.value === 'none'
                    ? null
                    : {
                        region: 'singapore',
                        resolution:
                          e.target.value === 'relay' ? '480P' : '720P',
                        wulusai:
                          e.target.value === 'relay'
                            ? {
                                ...media.defaultVideoRelay(),
                                model: 'grok-imagine-video-1.5-lite',
                                mode: 'text',
                              }
                            : null,
                      },
              })
            }}
          >
            <option value="relay">视频中转站</option>
            <option value="wan">万相图生视频</option>
            <option value="none">暂不配置，只创作剧本</option>
          </select>
        </label>
        {v?.wulusai && (
          <VideoRelayFields
            settings={v.wulusai}
            onChange={(wulusai) => {
              const model = getVideoModel(wulusai.model)
              setDraft({
                ...draft,
                video: {
                  ...v,
                  wulusai,
                  resolution: model.resolutions.includes(v.resolution)
                    ? v.resolution
                    : model.defaultResolution,
                },
              })
            }}
          />
        )}
        {v && !v.wulusai && (
          <label>
            万相地区
            <select
              aria-label="Agent 万相地区"
              value={v.region}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  video: {
                    ...v,
                    region: e.target.value as 'singapore' | 'beijing',
                  },
                })
              }
            >
              <option value="singapore">新加坡</option>
              <option value="beijing">北京</option>
            </select>
          </label>
        )}
        {v && (
          <>
            <label>
              视频分辨率
              <select
                aria-label="Agent 视频分辨率"
                value={v.resolution}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    video: {
                      ...v,
                      resolution: e.target
                        .value as media.VideoRequest['resolution'],
                    },
                  })
                }
              >
                {profile.resolutions.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <p className="field-hint">
              {profile.name} · 单条 {profile.duration.min}–
              {profile.duration.max} 秒。Agent
              根据参考图和模型能力选择文生或图生方式。
            </p>
            <label>
              视频密钥
              <input
                aria-label="Agent 视频密钥"
                type="password"
                value={videoKey}
                autoComplete="off"
                placeholder={
                  videoReady ? '已保存在系统凭据库' : '输入当前视频服务密钥'
                }
                onChange={(e) => setVideoKey(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="small-button"
              disabled={!isDesktop || busy || !videoKey.trim()}
              onClick={() =>
                void action(async () => {
                  if (v.wulusai)
                    await media.saveWulusaiVideoKey(v.wulusai.baseUrl, videoKey)
                  else await media.saveVideoKey(v.region, videoKey)
                  setVideoKey('')
                  setVideoReady(true)
                  setMessage('视频密钥已保存')
                })
              }
            >
              保存视频密钥
            </button>
            <span className="agent-connection-state">
              {videoReady ? '● 视频密钥已就绪' : '○ 待配置视频密钥'}
            </span>
          </>
        )}
        <label className="agent-check">
          <input
            type="checkbox"
            checked={!!draft.image}
            onChange={(e) =>
              setDraft({
                ...draft,
                image: e.target.checked
                  ? {
                      baseUrl: media.savedCloudImageBaseUrl(),
                      model: 'gpt-image-2',
                      size: '1536x1024',
                      quality: 'low',
                      budgetReservationMicroUsd: 250000,
                    }
                  : null,
              })
            }
          />
          允许 Agent 调用图片模型生成首帧
        </label>
        {draft.image && (
          <>
            <label>
              图片 API 地址
              <input
                aria-label="Agent 图片地址"
                type="url"
                value={draft.image.baseUrl}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    image: { ...draft.image!, baseUrl: e.target.value },
                  })
                }
              />
            </label>
            <label>
              图片模型
              <select
                aria-label="Agent 图片模型"
                value={draft.image.model}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    image: { ...draft.image!, model: e.target.value },
                  })
                }
              >
                {[
                  'gpt-image-2',
                  'gpt-image-2.5-flare',
                  'gpt-image-2.5-sunburst',
                ].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label>
              图片密钥
              <input
                aria-label="Agent 图片密钥"
                type="password"
                value={imageKey}
                autoComplete="off"
                placeholder={
                  imageReady ? '已保存在系统凭据库' : '输入图片服务密钥'
                }
                onChange={(e) => setImageKey(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="small-button"
              disabled={!isDesktop || busy || !imageKey.trim()}
              onClick={() =>
                void action(async () => {
                  await media.saveCloudImageKey(imageKey, draft.image!.baseUrl)
                  setImageKey('')
                  setImageReady(true)
                  setMessage('图片密钥已保存')
                })
              }
            >
              保存图片密钥
            </button>
          </>
        )}
        <label>
          每次创作的媒体预算预留上限 / USD
          <input
            aria-label="Agent 预算上限"
            type="number"
            min={0.01}
            max={1000}
            step={0.01}
            value={draft.budgetMicroUsd / 1000000}
            onChange={(e) =>
              setDraft({
                ...draft,
                budgetMicroUsd: Math.round(Number(e.target.value) * 1000000),
              })
            }
          />
        </label>
        <p className="field-hint">
          按本地预估与预留额限制自动提交；实际扣费以服务商为准，文本调用费用另计。当前单次视频生成，失败或未知结果不自动重新扣费重试。
        </p>
        <label className="agent-check">
          <input
            type="checkbox"
            checked={draft.autoSearchSkills}
            onChange={(e) =>
              setDraft({ ...draft, autoSearchSkills: e.target.checked })
            }
          />
          需要新知识时自动搜索、下载文档技能
        </label>
        {message && <p>{message}</p>}
        {error && (
          <p className="agent-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button type="button" className="small-button" onClick={onClose}>
            关闭
          </button>
          <button
            className="button primary"
            disabled={!isDesktop || busy || !draft.providerId}
          >
            保存 Agent 配置
          </button>
        </footer>
      </form>
    </dialog>
  )
}
