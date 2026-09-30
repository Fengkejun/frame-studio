import { useEffect, useState } from 'react'
import { errorMessage } from './api'
import { exportPreview, type ExportJob } from './mediaApi'

export function ExportPreview({
  job,
  onClose,
}: {
  job: ExportJob
  onClose: () => void
}) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void exportPreview(job.id)
      .then((value) => {
        if (alive) setUrl(value)
      })
      .catch((reason) => {
        if (alive) setError(errorMessage(reason))
      })
    return () => {
      alive = false
    }
  }, [job.id])
  return (
    <section className="export-preview" aria-label="成片预览">
      <div className="timeline-heading">
        <h3>成片预览</h3>
        <button className="small-button" onClick={onClose} autoFocus>
          关闭成片预览
        </button>
      </div>
      <small className="timeline-path">{job.outputPath}</small>
      {error ? (
        <p className="workflow-error" role="alert">
          {error}
        </p>
      ) : url ? (
        <video
          controls
          playsInline
          preload="metadata"
          aria-label="成片播放器"
          src={url}
          onError={() =>
            setError('成片播放失败，请检查文件是否完整或重新导出。')
          }
        />
      ) : (
        <p role="status" className="field-hint">
          正在加载成片…
        </p>
      )}
    </section>
  )
}
