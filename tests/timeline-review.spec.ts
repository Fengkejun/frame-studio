import { expect, test } from '@playwright/test'
import {
  storyboardOrder,
  suggestedCues,
  voiceCueError,
} from '../src/features/workflow/timelineReview'
import type { Composition } from '../src/features/workflow/mediaApi'
import { defaultEffects } from '../src/features/workflow/timelineTiming'

test('storyboard order preserves trims and captions instead of insertion order', () => {
  const clips = [
    {
      versionId: 'shot2',
      trimStartMs: 100,
      trimEndMs: 4000,
      caption: 'second',
    },
    { versionId: 'shot1', trimStartMs: 0, trimEndMs: 4000, caption: 'first' },
  ]
  expect(
    storyboardOrder(
      clips,
      new Map([
        ['shot1', 0],
        ['shot2', 1],
      ]),
    ),
  ).toEqual([clips[1], clips[0]])
  expect(clips[0]?.versionId).toBe('shot2')
})
test('pause suggestions reject uncertain sentence counts and validate placement', () => {
  const clips = ['a', 'b', 'c'].map((versionId) => ({
    versionId,
    trimStartMs: 0,
    trimEndMs: 4000,
    caption: versionId,
  }))
  const wave = {
    versionId: 'voice',
    durationMs: 6000,
    peaks: Array.from({ length: 600 }, (_, i) =>
      i < 120 || (i >= 200 && i < 340) || (i >= 420 && i < 550) ? 0.4 : 0,
    ),
  }
  const cues = suggestedCues(clips, wave)
  expect(cues).toHaveLength(3)
  expect(cues[1]!.sourceStartMs).toBe(1920)
  expect(() => suggestedCues(clips.slice(0, 2), wave)).toThrow('3 段声音')
  const draft: Composition = {
    workflowId: 'w',
    clips,
    voiceCues: cues,
    voiceVersionId: 'voice',
    voiceStartMs: 0,
    aspect: '9:16',
    resolution: 720,
    quality: 'balanced',
    musicVersionId: null,
    musicVolume: 35,
    subtitleFormat: 'none',
    subtitleText: '',
    subtitleVersionId: null,
    effects: { ...defaultEffects },
  }
  expect(voiceCueError(draft, 6000)).toBe('')
  expect(
    voiceCueError(
      {
        ...draft,
        clips: [{ ...clips[0]!, trimEndMs: 100 }, ...clips.slice(1)],
      },
      6000,
    ),
  ).toContain('片段 1')
  expect(
    voiceCueError({ ...draft, voiceCues: [...cues, cues[0]!] }, 6000),
  ).toContain('重复')
  expect(voiceCueError({ ...draft, voiceStartMs: 50 }, 6000)).toContain('起点')
})
