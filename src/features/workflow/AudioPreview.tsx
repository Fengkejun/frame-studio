import { useState } from 'react'
import { errorMessage } from './api'
import { audioPreview } from './mediaApi'
import { isDesktop } from '@/shared/lib/desktop'

export function AudioPreview({ versionId }: { versionId: string }) {
  return <AudioPlayer key={versionId} versionId={versionId} />
}

function AudioPlayer({ versionId }: { versionId: string }) {
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function load() {
    setBusy(true)
    setError('')
    try {
      setSource(await audioPreview(versionId))
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="audio-preview">
      {source ? (
        <audio controls preload="metadata" src={source} aria-label="音频试听" />
      ) : (
        <button
          className="small-button"
          disabled={!isDesktop || busy}
          onClick={() => void load()}
        >
          {busy ? '读取中…' : '试听音频'}
        </button>
      )}
      {error && (
        <p className="workflow-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
