import type { Composition } from './mediaApi'

export const defaultEffects: Composition['effects'] = {
  transition: 'none',
  transitionDurationMs: 300,
  musicFadeInMs: 0,
  musicFadeOutMs: 0,
  voiceFadeInMs: 0,
  voiceFadeOutMs: 0,
}

export function timelineLayout(draft: Pick<Composition, 'clips' | 'effects'>) {
  const requestedOverlapMs =
    draft.clips.length > 1 && draft.effects.transition !== 'none'
      ? draft.effects.transitionDurationMs
      : 0
  const overlapFrames = Math.round((requestedOverlapMs * 30) / 1000)
  const overlapMs = Math.round((overlapFrames * 1000) / 30)
  let totalFrames = 0
  const startsMs = draft.clips.map((clip, i) => {
    if (i) totalFrames -= overlapFrames
    const start = Math.round((totalFrames * 1000) / 30)
    totalFrames += Math.ceil(
      (Math.max(0, clip.trimEndMs - clip.trimStartMs) * 30) / 1000,
    )
    return start
  })
  const invalid =
    requestedOverlapMs > 0 &&
    draft.clips.some(
      (clip) =>
        requestedOverlapMs * 2 > clip.trimEndMs - clip.trimStartMs ||
        overlapFrames * 2 >
          Math.ceil(((clip.trimEndMs - clip.trimStartMs) * 30) / 1000),
    )
  return {
    totalMs: Math.max(0, Math.round((totalFrames * 1000) / 30)),
    startsMs,
    overlapMs,
    invalid,
  }
}

export function audioFadeError(
  draft: Composition,
  totalMs: number,
  voiceDurationMs: number | undefined,
) {
  if (
    draft.musicVersionId &&
    draft.effects.musicFadeInMs + draft.effects.musicFadeOutMs > totalMs
  )
    return '音乐淡入与淡出总时长须不超过成片时长。'
  if (draft.voiceVersionId && voiceDurationMs !== undefined) {
    const audible = Math.max(
      0,
      Math.min(voiceDurationMs, totalMs - draft.voiceStartMs),
    )
    if (draft.effects.voiceFadeInMs + draft.effects.voiceFadeOutMs > audible)
      return '配音淡入与淡出总时长须不超过成片中实际播放的配音时长。'
  }
  return ''
}
