import type { Workflow } from './model'
import type {
  AudioWaveform,
  Composition,
  TimelineClip,
  VideoAsset,
  VoiceCue,
} from './mediaApi'
import { timelineLayout } from './timelineTiming'

export function storyboardRanks(workflow: Workflow, assets: VideoAsset[]) {
  const shots = workflow.nodes.flatMap((n) =>
    n.output?.value && 'shots' in n.output.value
      ? n.output.value.shots.map((s) => ({
          nodeId: n.id,
          artifactId: n.output!.id,
          shotId: s.id,
        }))
      : [],
  )
  return new Map(
    assets.map((asset) => [
      asset.versionId,
      shots.findIndex(
        (s) =>
          s.nodeId === asset.context.nodeId &&
          s.artifactId === asset.context.artifactId &&
          s.shotId === asset.context.shotId,
      ),
    ]),
  )
}
export function storyboardOrder(
  clips: TimelineClip[],
  ranks: Map<string, number>,
) {
  const rank = (id: string) => {
    const v = ranks.get(id)
    return v !== undefined && v >= 0 ? v : Number.MAX_SAFE_INTEGER
  }
  return [...clips].sort((a, b) => rank(a.versionId) - rank(b.versionId))
}
export function speechRegions(wave: AudioWaveform) {
  // Approximate source ranges from the local waveform, not speech recognition.
  const step = wave.durationMs / wave.peaks.length
  const points = wave.peaks.flatMap((v, i) => (v >= 0.013 ? [i] : []))
  const groups: { start: number; end: number }[] = []
  for (const p of points) {
    const last = groups.at(-1)
    if (last && (p - last.end - 1) * step < 350) last.end = p
    else groups.push({ start: p, end: p })
  }
  return groups
    .filter((g) => (g.end - g.start + 1) * step >= 120)
    .map((g) => ({
      sourceStartMs: Math.max(0, Math.floor(g.start * step - 80)),
      sourceEndMs: Math.min(
        wave.durationMs,
        Math.ceil((g.end + 1) * step + 80),
      ),
    }))
}
export function voiceCueError(
  draft: Composition,
  duration: number | undefined,
) {
  const cues = draft.voiceCues ?? []
  if (!cues.length) return ''
  if (
    !draft.voiceVersionId ||
    draft.voiceStartMs !== 0 ||
    draft.subtitleFormat !== 'none' ||
    draft.subtitleVersionId ||
    draft.effects.voiceFadeInMs ||
    draft.effects.voiceFadeOutMs
  )
    return '分镜配音须使用片段台词字幕，配音起点和淡入淡出为零。'
  const layout = timelineLayout(draft)
  const ids = new Set<string>()
  for (const cue of cues) {
    const i = draft.clips.findIndex((c) => c.versionId === cue.clipVersionId)
    if (i < 0 || ids.has(cue.clipVersionId))
      return '配音分句包含重复或已移除的镜头。'
    ids.add(cue.clipVersionId)
    const start = layout.startsMs[i]! + (i ? layout.overlapMs / 2 : 0)
    const end =
      i + 1 < draft.clips.length
        ? layout.startsMs[i + 1]! + layout.overlapMs / 2
        : layout.totalMs
    if (
      !Number.isInteger(cue.sourceStartMs) ||
      !Number.isInteger(cue.sourceEndMs) ||
      cue.sourceStartMs < 0 ||
      cue.sourceEndMs <= cue.sourceStartMs ||
      cue.sourceEndMs > (duration ?? 3600000) ||
      cue.sourceEndMs - cue.sourceStartMs > end - start
    )
      return `片段 ${i + 1} 的配音范围超出源音频或当前镜头时长。`
  }
  return ''
}
export function suggestedCues(
  clips: TimelineClip[],
  wave: AudioWaveform,
): VoiceCue[] {
  const regions = speechRegions(wave)
  if (regions.length !== clips.length)
    throw new Error(
      `检测到 ${regions.length} 段声音、当前有 ${clips.length} 个镜头，请手动设置分句；尚未修改时间线。`,
    )
  return clips.map((c, i) => ({ clipVersionId: c.versionId, ...regions[i]! }))
}
