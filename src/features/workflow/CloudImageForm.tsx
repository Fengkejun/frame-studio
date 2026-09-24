import { useEffect, useState } from 'react'
import { isDesktop } from '@/shared/lib/desktop'
import { errorMessage } from './api'
import * as api from './mediaApi'
import type { Shot } from './model'

export function CloudImageForm({
  context,
  shot,
  disabled,
  onStart,
  onError,
}: {
  context: api.ShotContext
  shot: Shot
  disabled: boolean
  onStart: (request: api.CloudImageRequest) => Promise<void>
  onError: (message: string) => void
}) {
  const [request, setRequest] = useState<api.CloudImageRequest>({
    context,
    model: 'gpt-image-2',
    positive: shot.imagePrompt,
    negative: '',
    size: '1024x1536',
    quality: 'low',
  })
  const [key, setKey] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [checking, setChecking] = useState(true)
  const [savingKey, setSavingKey] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .cloudImageKeyStatus()
      .then((saved) => {
        if (alive) setHasKey(saved)
      })
      .catch((e) => {
        if (alive) onError(errorMessage(e))
      })
      .finally(() => {
        if (alive) setChecking(false)
      })
    return () => {
      alive = false
    }
  }, [onError])

  async function saveKey() {
    setSavingKey(true)
    try {
      await api.saveCloudImageKey(key)
      setKey('')
      setHasKey(true)
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setSavingKey(false)
    }
  }

  async function clearKey() {
    setSavingKey(true)
    try {
      await api.clearCloudImageKey()
      setHasKey(false)
    } catch (e) {
      onError(errorMessage(e))
    } finally {
      setSavingKey(false)
    }
  }

  return (
    <form
      className="image-form"
      onSubmit={(e) => {
        e.preventDefault()
        void onStart(request)
      }}
    >
      <fieldset disabled={!isDesktop || checking || disabled || savingKey}>
        <p className="field-hint">
          通过 OpenAI Images API 生成，无需安装 ComfyUI。需要可用的 API Key
          和网络连接；每次提交会产生云端费用。
        </p>
        <label className="field-label">
          OpenAI 图片 API Key
          <input
            aria-label="OpenAI 图片 API Key"
            type="password"
            autoComplete="off"
            value={key}
            placeholder={
              hasKey ? '已保存在系统凭据库' : '填写后保存到系统凭据库'
            }
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="small-button"
            disabled={!key.trim()}
            onClick={() => void saveKey()}
          >
            保存密钥
          </button>
          {hasKey && (
            <button
              type="button"
              className="text-button"
              onClick={() => void clearKey()}
            >
              移除密钥
            </button>
          )}
        </div>
        <p className="field-hint" role="status">
          {hasKey
            ? '密钥已保存在系统凭据库，不写入项目或任务记录。'
            : '请先保存密钥。'}
        </p>
        <label className="field-label">
          图片模型
          <select
            aria-label="云端图片模型"
            value={request.model}
            onChange={(e) =>
              setRequest((r) => ({
                ...r,
                model: e.target.value as api.CloudImageRequest['model'],
              }))
            }
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
        <button
          className="button primary generate-image-button"
          type="submit"
          disabled={!hasKey}
        >
          生成 1 张云端候选图
        </button>
        <p className="field-hint">
          请求提交后无法远程取消。网络超时或应用关闭时会标记结果未知，请先核对服务商用量再重试。
        </p>
      </fieldset>
    </form>
  )
}
