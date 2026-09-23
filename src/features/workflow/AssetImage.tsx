import { useEffect, useState } from 'react'
import { imagePreview } from './mediaApi'

export function AssetImage({
  versionId,
  alt,
}: {
  versionId: string
  alt: string
}) {
  const [preview, setPreview] = useState<{
    id: string
    url?: string
    error?: boolean
  }>()
  useEffect(() => {
    let alive = true
    imagePreview(versionId)
      .then((url) => {
        if (alive) setPreview({ id: versionId, url })
      })
      .catch(() => {
        if (alive) setPreview({ id: versionId, error: true })
      })
    return () => {
      alive = false
    }
  }, [versionId])
  if (preview?.id !== versionId || !preview.url)
    return (
      <div className="asset-placeholder">
        {preview?.id === versionId && preview.error
          ? '预览不可用'
          : '加载预览…'}
      </div>
    )
  return <img src={preview.url} alt={alt} loading="lazy" draggable={false} />
}
