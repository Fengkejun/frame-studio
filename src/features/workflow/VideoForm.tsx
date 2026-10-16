import { useEffect, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from './api'
import * as api from './mediaApi'
import { MediaBudgetPanel } from './MediaBudgetPanel'
import { BatchSubmit, type BatchTarget } from './ImageBatch'
import type { Shot } from './model'
import { VideoRelayFields } from './VideoRelayFields'
import { getVideoModel, wanVideoModel } from './videoModels'
import { videoSettingsKey, withSavedVideoSettings } from './videoPreferences'

export function VideoForm({
  context,
  firstFrameVersionId,
  shot,
  disabled,
  onStart,
  onError,
  batchTargets,
  onBatch,
  sequence,
}: {
  context: api.ShotContext
  firstFrameVersionId: string
  shot: Shot
  disabled: boolean
  onStart: (request: api.VideoRequest) => Promise<void>
  onError: (message: string) => void
  batchTargets: BatchTarget[]
  onBatch: (requests: api.BatchRequest[]) => Promise<void>
  sequence?: { shotIds: string[] }
}) {
  const [request, setRequest] = useState<api.VideoRequest>(() => {
    const saved = withSavedVideoSettings({
      context,
      firstFrameVersionId,
      region: 'singapore',
      prompt: shot.videoPrompt,
      negativePrompt: '',
      duration: Math.round(shot.duration),
      resolution: wanVideoModel.defaultResolution,
    })
    return sequence
      ? normalize({
          ...saved,
          sequence,
          wulusai: {
            ...(saved.wulusai ?? api.defaultVideoRelay()),
            mode: 'text',
          },
        })
      : saved
  })
  function normalize(value: api.VideoRequest) {
    const next = api.normalizeVideoRequest(value)
    return sequence
      ? {
          ...next,
          duration: shot.duration,
          firstFrameVersionId:
            next.wulusai?.mode === 'text' ? '' : firstFrameVersionId,
        }
      : next
  }
  const sequenceError =
    sequence &&
    (!Number.isInteger(shot.duration) ||
      shot.duration < api.videoMinimumDuration(request) ||
      shot.duration > api.videoMaximumDuration(request))
      ? `分镜共 ${shot.duration} 秒，当前模型支持 ${api.videoMinimumDuration(request)}–${api.videoMaximumDuration(request)} 秒；请调整分镜总时长，或接入支持延展的服务。不会自动截短或拆成多次收费任务。`
      : ''
  useEffect(() => {
    try {
      localStorage.setItem(
        videoSettingsKey,
        JSON.stringify({
          region: request.region,
          resolution: request.resolution,
          wulusai: request.wulusai ?? null,
        }),
      )
    } catch {
      /* Keep the current session usable if preferences are blocked. */
    }
  }, [request.region, request.resolution, request.wulusai])
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [checking, setChecking] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [connection, setConnection] = useState<api.ConnectionCheck | null>(null)
  const [budgetRevision, setBudgetRevision] = useState(0)
  const relay = request.wulusai
  const baseUrl = relay?.baseUrl
  function resetConnection() {
    setChecking(true)
    setHasKey(false)
    setConnection(null)
    setKey('')
  }
  useEffect(() => {
    let alive = true
    const check =
      baseUrl !== undefined
        ? api.wulusaiVideoKeyStatus(baseUrl)
        : api.videoKeyStatus(request.region)
    check
      .then((result) => {
        if (alive) setHasKey(result)
      })
      .catch((error) => {
        if (alive) onError(errorMessage(error))
      })
      .finally(() => {
        if (alive) setChecking(false)
      })
    return () => {
      alive = false
    }
  }, [request.region, baseUrl, onError])
  return (
    <form
      className="image-form"
      onSubmit={(event) => {
        event.preventDefault()
        void onStart(request).then(
          () => setBudgetRevision((value) => value + 1),
          () => setBudgetRevision((value) => value + 1),
        )
      }}
    >
      <fieldset
        disabled={!isDesktop || checking || disabled || saving || testing}
      >
        <p className="field-hint">
          {relay
            ? '视频中转站。提交前请核对模型、生成方式、时长、画幅与预算预留。'
            : '万相 Wan 2.7 图生视频。任务按秒计费，提交前请核对地区、时长与分辨率。'}
        </p>
        <label className="field-label">
          视频服务
          <select
            aria-label="视频服务"
            value={relay ? 'relay' : 'wan'}
            onChange={(e) => {
              resetConnection()
              const next =
                e.target.value === 'relay' ? api.defaultVideoRelay() : null
              setRequest((r) =>
                normalize({
                  ...r,
                  wulusai: next,
                  resolution: api.videoModelFor({ wulusai: next })
                    .defaultResolution,
                }),
              )
            }}
          >
            <option value="wan">阿里云万相 · 图生视频</option>
            <option value="relay">视频中转站</option>
          </select>
        </label>
        {relay && (
          <VideoRelayFields
            settings={relay}
            onChange={(next) => {
              if (next.baseUrl !== relay.baseUrl) resetConnection()
              if (next.model !== relay.model) {
                setConnection(null)
                next = {
                  ...next,
                  mode: getVideoModel(next.model).defaultMode,
                  ratio: null,
                }
              }
              setRequest((r) => normalize({ ...r, wulusai: next }))
            }}
          />
        )}
        {!relay && (
          <>
            <label className="field-label">
              服务地区
              <select
                aria-label="视频服务地区"
                value={request.region}
                onChange={(event) => {
                  setChecking(true)
                  setHasKey(false)
                  setConnection(null)
                  setKey('')
                  setRequest((value) => ({
                    ...value,
                    region: event.target.value as api.VideoRequest['region'],
                  }))
                }}
              >
                <option value="singapore">新加坡</option>
                <option value="beijing">北京</option>
              </select>
            </label>
          </>
        )}
        <label className="field-label">
          {relay ? '中转站 API Key' : '万相 API Key'}
          <input
            aria-label={relay ? '中转站 API Key' : '万相 API Key'}
            type="password"
            autoComplete="off"
            value={key}
            placeholder={
              hasKey ? '已保存在系统凭据库' : '输入当前视频服务的 API Key'
            }
            onChange={(event) => {
              setConnection(null)
              setKey(event.target.value)
            }}
          />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="small-button"
            disabled={!key.trim()}
            onClick={() => {
              setSaving(true)
              void (
                relay
                  ? api.saveWulusaiVideoKey(relay.baseUrl, key)
                  : api.saveVideoKey(request.region, key)
              )
                .then(() => {
                  setKey('')
                  setHasKey(true)
                  setConnection(null)
                })
                .catch((error) => onError(errorMessage(error)))
                .finally(() => setSaving(false))
            }}
          >
            保存密钥
          </button>
          {hasKey && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setSaving(true)
                void (
                  relay
                    ? api.clearWulusaiVideoKey(relay.baseUrl)
                    : api.clearVideoKey(request.region)
                )
                  .then(() => {
                    setHasKey(false)
                    setConnection(null)
                  })
                  .catch((error) => onError(errorMessage(error)))
                  .finally(() => setSaving(false))
              }}
            >
              移除密钥
            </button>
          )}
          <button
            type="button"
            className="small-button"
            disabled={!hasKey || !!key.trim()}
            onClick={() => {
              setTesting(true)
              setConnection(null)
              void (
                relay
                  ? api.checkWulusaiVideoConnection(relay.baseUrl, relay.model)
                  : api.checkVideoConnection(request.region)
              )
                .then(setConnection)
                .catch((error) => onError(errorMessage(error)))
                .finally(() => setTesting(false))
            }}
          >
            {testing ? '检查中…' : '检查连接'}
          </button>
        </div>
        <p className="field-hint" role="status">
          {hasKey
            ? relay
              ? '当前中转站密钥已保存在系统凭据库。'
              : '当前地区密钥已保存在系统凭据库。'
            : relay
              ? '请先保存当前中转站的 API Key。'
              : '请先保存当前地区的 API Key。'}
        </p>
        {connection && (
          <p
            className={
              connection.status === 'connected' ||
              connection.status === 'model_not_listed'
                ? 'field-hint'
                : 'workflow-error'
            }
            role="status"
          >
            {connection.message}
          </p>
        )}
        <label className="field-label">
          视频提示词
          <textarea
            aria-label="视频提示词"
            required={api.videoPromptRequired(request)}
            maxLength={5000}
            rows={5}
            value={request.prompt}
            onChange={(event) =>
              setRequest((value) => ({ ...value, prompt: event.target.value }))
            }
          />
        </label>
        <button
          type="button"
          className="text-button"
          onClick={() =>
            setRequest((value) => ({ ...value, prompt: shot.videoPrompt }))
          }
        >
          重新带入分镜视频提示词
        </button>
        <label className="field-label">
          避免出现的元素
          <textarea
            aria-label="视频负面提示词"
            maxLength={500}
            rows={2}
            value={request.negativePrompt}
            onChange={(event) =>
              setRequest((value) => ({
                ...value,
                negativePrompt: event.target.value,
              }))
            }
          />
        </label>
        <div className="image-number-grid">
          <label className="field-label">
            时长 / 秒
            <input
              aria-label="视频时长"
              type="number"
              required
              min={api.videoMinimumDuration(request)}
              max={api.videoMaximumDuration(request)}
              step={1}
              value={request.duration}
              readOnly={!!sequence}
              onChange={(event) =>
                setRequest((value) => ({
                  ...value,
                  duration: Number(event.target.value),
                }))
              }
            />
          </label>
          <label className="field-label">
            分辨率
            <select
              aria-label="视频分辨率"
              value={request.resolution}
              onChange={(event) =>
                setRequest((value) => ({
                  ...value,
                  resolution: event.target
                    .value as api.VideoRequest['resolution'],
                }))
              }
            >
              {api.videoResolutions(relay).map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="field-hint" role="status">
          {relay ? '本次视频预算预留：' : '本次视频标价预估：'}
          {api.formatUsd(
            api.videoEstimateMicroUsd(
              request.region,
              request.resolution,
              request.duration,
              relay,
            ),
          )}
          （
          {relay
            ? '视频中转站'
            : request.region === 'beijing'
              ? '北京'
              : '新加坡'}{' '}
          · {request.resolution} · {request.duration}{' '}
          秒）。优惠和实际扣费以服务商账单为准。
        </p>
        <MediaBudgetPanel
          workflowId={context.workflowId}
          refreshSignal={budgetRevision}
        />
        <button
          type="submit"
          className="button primary generate-image-button"
          disabled={
            !hasKey ||
            !!sequenceError ||
            (!!sequence && !request.prompt.trim()) ||
            (!!sequence && !firstFrameVersionId && relay?.mode !== 'text') ||
            request.prompt.length > 5000
          }
        >
          {sequence
            ? `一次提交整段分镜（${shot.duration} 秒）`
            : relay && relay.mode === 'text'
              ? '提交文生视频任务'
              : '提交图生视频任务'}
        </button>
        <p className="field-hint">
          停止只结束本地查询，不会取消远程生成。拿到任务 ID
          后可继续查询；提交结果未知时请先核对服务商用量。
        </p>
        {sequenceError && (
          <p className="workflow-error" role="alert">
            {sequenceError}
          </p>
        )}
        {sequence && !firstFrameVersionId && relay?.mode !== 'text' && (
          <p className="field-hint">
            图生模式需先确认第一镜头首帧；文生模式可直接使用整段提示词。
          </p>
        )}
        {!sequence && (
          <BatchSubmit
            targets={batchTargets}
            request={{ kind: 'video', request }}
            disabled={!hasKey}
            onStart={(requests) =>
              onBatch(requests).finally(() => setBudgetRevision((v) => v + 1))
            }
          />
        )}
      </fieldset>
    </form>
  )
}
