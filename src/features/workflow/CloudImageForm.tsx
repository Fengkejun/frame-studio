import { useEffect, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from './api'
import { MediaBudgetPanel } from './MediaBudgetPanel'
import * as api from './mediaApi'
import type { Shot } from './model'

export function CloudImageForm({
  context,
  shot,
  disabled,
  onStart,
  onError,
  roleReferences,
  assets,
}: {
  context: api.ShotContext
  shot: Shot
  disabled: boolean
  onStart: (request: api.CloudImageRequest) => Promise<void>
  onError: (message: string) => void
  roleReferences: api.RoleReference[]
  assets: api.ImageAsset[]
}) {
  const [request, setRequest] = useState<api.CloudImageRequest>({
    context,
    baseUrl: api.savedCloudImageBaseUrl(),
    model: 'gpt-image-2',
    positive: shot.imagePrompt,
    negative: '',
    size: '1024x1536',
    quality: 'low',
    budgetReservationMicroUsd: 250_000,
  })
  const [reservationText, setReservationText] = useState('0.25')
  const [budgetRevision, setBudgetRevision] = useState(0)
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [checking, setChecking] = useState(true)
  const [savingKey, setSavingKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [connection, setConnection] = useState<api.ConnectionCheck | null>(null)

  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      void api
        .cloudImageKeyStatus(request.baseUrl)
        .then((saved) => {
          if (!alive) return
          setHasKey(saved)
          try {
            localStorage.setItem(
              api.cloudImageBaseUrlStorageKey,
              request.baseUrl,
            )
          } catch {
            // A blocked preference store should not block the current session.
          }
        })
        .catch((e) => {
          if (alive) onError(errorMessage(e))
        })
        .finally(() => {
          if (alive) setChecking(false)
        })
    }, 300)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [onError, request.baseUrl])

  async function saveKey() {
    setSavingKey(true)
    try {
      await api.saveCloudImageKey(key, request.baseUrl)
      setKey('')
      setHasKey(true)
      setConnection(null)
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setSavingKey(false)
    }
  }

  async function clearKey() {
    setSavingKey(true)
    try {
      await api.clearCloudImageKey(request.baseUrl)
      setHasKey(false)
      setConnection(null)
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setSavingKey(false)
    }
  }

  async function checkConnection() {
    setTesting(true)
    setConnection(null)
    try {
      setConnection(
        await api.checkCloudImageConnection(request.model, request.baseUrl),
      )
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setTesting(false)
    }
  }

  return (
    <form
      className="image-form"
      onSubmit={(e) => {
        e.preventDefault()
        void onStart(request).then(
          () => setBudgetRevision((value) => value + 1),
          () => setBudgetRevision((value) => value + 1),
        )
      }}
    >
      <fieldset disabled={!isDesktop || disabled || savingKey || testing}>
        <p className="field-hint">
          通过 OpenAI 兼容的 Images API 生成，无需安装 ComfyUI。需要可用的 API
          Key 和网络连接；每次提交会产生云端费用。
        </p>
        <label className="field-label">
          云端图片 API 根地址
          <input
            aria-label="云端图片 API 根地址"
            type="url"
            value={request.baseUrl}
            onChange={(e) => {
              setKey('')
              setChecking(true)
              setHasKey(false)
              setConnection(null)
              setRequest((value) => ({ ...value, baseUrl: e.target.value }))
            }}
          />
        </label>
        <p className="field-hint">
          地址路径为 /v1。每个地址的密钥分别保存在系统凭据库。
        </p>
        <label className="field-label">
          云端图片 API Key
          <input
            aria-label="云端图片 API Key"
            type="password"
            autoComplete="off"
            value={key}
            placeholder={
              hasKey ? '已保存在系统凭据库' : '填写后保存到系统凭据库'
            }
            onChange={(e) => {
              setConnection(null)
              setKey(e.target.value)
            }}
          />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="small-button"
            disabled={!key.trim() || checking}
            onClick={() => void saveKey()}
          >
            保存密钥
          </button>
          {hasKey && (
            <button
              type="button"
              className="text-button"
              disabled={checking}
              onClick={() => void clearKey()}
            >
              移除密钥
            </button>
          )}
          <button
            type="button"
            className="small-button"
            disabled={!hasKey || !!key.trim() || checking}
            onClick={() => void checkConnection()}
          >
            {testing ? '检查中…' : '检查连接'}
          </button>
        </div>
        <p className="field-hint" role="status">
          {hasKey
            ? '密钥已保存在系统凭据库，不写入项目或任务记录。'
            : '请先保存密钥。'}
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
          生图方式
          <select
            aria-label="云端生图方式"
            value={request.referenceVersionId ?? ''}
            onChange={(e) =>
              setRequest((r) => ({
                ...r,
                referenceVersionId: e.target.value || null,
              }))
            }
          >
            <option value="">文生图 · 仅使用提示词</option>
            {roleReferences.map((reference) => {
              const asset = assets.find(
                (item) => item.versionId === reference.versionId,
              )
              return (
                <option key={reference.roleName} value={reference.versionId}>
                  图生图 · {reference.roleName} ·{' '}
                  {asset?.name ?? reference.versionId.slice(0, 8)}
                </option>
              )
            })}
          </select>
        </label>
        <p className="field-hint">
          图生图会读取所选角色参考图的固定版本，生成新候选图；不会覆盖参考图。
        </p>
        <label className="field-label">
          图片模型
          <select
            aria-label="云端图片模型"
            value={request.model}
            onChange={(e) => {
              setConnection(null)
              setRequest((r) => ({
                ...r,
                model: e.target.value as api.CloudImageRequest['model'],
              }))
            }}
          >
            <option value="gpt-image-2">GPT Image 2 · 经济</option>
            <option value="gpt-image-2.5-flare">
              GPT Image 2.5 Flare · 快速
            </option>
            <option value="gpt-image-2.5-sunburst">
              GPT Image 2.5 Sunburst · 精细
            </option>
          </select>
        </label>
        <label className="field-label">
          正面提示词
          <textarea
            aria-label="云端生图提示词"
            required
            maxLength={16000}
            rows={5}
            value={request.positive}
            onChange={(e) =>
              setRequest((r) => ({ ...r, positive: e.target.value }))
            }
          />
        </label>
        <button
          type="button"
          className="text-button"
          onClick={() =>
            setRequest((r) => ({ ...r, positive: shot.imagePrompt }))
          }
        >
          重新带入分镜提示词
        </button>
        <label className="field-label">
          不希望出现的画面元素
          <textarea
            aria-label="云端生图避免元素"
            maxLength={4000}
            rows={2}
            value={request.negative}
            onChange={(e) =>
              setRequest((r) => ({ ...r, negative: e.target.value }))
            }
          />
        </label>
        <p className="field-hint">
          此项会作为普通文字要求附在提示词后，云端接口没有独立的负面提示词参数。
        </p>
        <div className="image-number-grid">
          <label className="field-label">
            画幅
            <select
              aria-label="云端图片画幅"
              value={request.size}
              onChange={(e) =>
                setRequest((r) => ({
                  ...r,
                  size: e.target.value as api.CloudImageRequest['size'],
                }))
              }
            >
              <option value="1024x1536">竖屏 · 1024 × 1536</option>
              <option value="1536x1024">横屏 · 1536 × 1024</option>
              <option value="1024x1024">方形 · 1024 × 1024</option>
            </select>
          </label>
          <label className="field-label">
            画质
            <select
              aria-label="云端图片画质"
              value={request.quality}
              onChange={(e) =>
                setRequest((r) => ({
                  ...r,
                  quality: e.target.value as api.CloudImageRequest['quality'],
                }))
              }
            >
              <option value="low">低 · 较省费用</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </label>
        </div>
        <label className="field-label">
          本次预算预留 / USD
          <input
            aria-label="本次图片预算预留"
            type="number"
            min="0.01"
            max="1000"
            step="0.01"
            required
            value={reservationText}
            onChange={(event) => {
              setReservationText(event.target.value)
              setRequest((value) => ({
                ...value,
                budgetReservationMicroUsd: Math.round(
                  Number(event.target.value) * 1_000_000,
                ),
              }))
            }}
          />
        </label>
        <p className="field-hint">
          图片按实际输入、输出 token
          计费；这里填写的是你愿意为本次请求预留的预算，不代表最终费用。当前预留：
          {api.formatUsd(request.budgetReservationMicroUsd)}。
        </p>
        <MediaBudgetPanel
          workflowId={context.workflowId}
          refreshSignal={budgetRevision}
        />
        <button
          className="button primary generate-image-button"
          type="submit"
          disabled={!hasKey || checking}
        >
          {request.referenceVersionId
            ? '参考图生成 1 张候选图'
            : '生成 1 张云端候选图'}
        </button>
        <p className="field-hint">
          请求提交后无法远程取消。网络超时或应用关闭时会标记结果未知，请先核对服务商用量再重试。
        </p>
      </fieldset>
    </form>
  )
}
