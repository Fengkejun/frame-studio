import { useState } from 'react'
import * as api from './mediaApi'

export function CloudImageRecovery({
  job,
  disabled,
  onRecover,
}: {
  job: api.CloudImageJob
  disabled: boolean
  onRecover: (url?: string) => Promise<void>
}) {
  const [url, setUrl] = useState('')
  return (
    <details className="cloud-image-recovery">
      <summary>找回已有图片（不重新生成）</summary>
      <p className="field-hint">
        从服务商复制本次任务的图片链接。这里只下载已有图片，保持原预算记录；下载后请核对画面，再选择首帧。
      </p>
      <label className="field-label">
        已生成图片链接
        <input
          aria-label="已生成图片链接"
          type="url"
          value={url}
          placeholder={
            job.resultUrl
              ? '已保留原链接，也可粘贴更新后的链接'
              : 'https://…/image.png'
          }
          disabled={disabled}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <button
        className="small-button"
        disabled={disabled || (!job.resultUrl && !url.trim())}
        onClick={() => void onRecover(url.trim() || undefined)}
      >
        {job.resultUrl && !url.trim()
          ? '重新下载已有图片'
          : '下载并找回此任务图片'}
      </button>
    </details>
  )
}
