import { expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export async function testFilmReview(page, profile) {
  const invoke = (command, args = {}) =>
    page.evaluate(
      ({ command, args }) =>
        globalThis.__TAURI_INTERNALS__.invoke(command, args),
      { command, args },
    )
  const workflows = await invoke('list_workflows')
  const workflow = workflows.find((w) =>
    w.nodes.some((n) => n.id === 'timeline-fixture'),
  )
  const previous = await invoke('get_composition', { workflowId: workflow.id })
  const videos = await invoke('list_video_assets', { workflowId: workflow.id })
  const selected = await invoke('list_selected_videos', {
    workflowId: workflow.id,
  })
  const video = videos.find((v) =>
    selected.some((s) => s.versionId === v.versionId),
  )
  const audio = (
    await invoke('list_audio_assets', { workflowId: workflow.id })
  ).find((a) => a.name === 'voice.wav')
  const draft = {
    ...previous,
    clips: [
      {
        versionId: video.versionId,
        trimStartMs: 0,
        trimEndMs: 1000,
        caption: '',
      },
    ],
    aspect: '9:16',
    resolution: 720,
    musicVersionId: null,
    voiceVersionId: audio.versionId,
    voiceStartMs: 0,
    voiceCues: [
      { clipVersionId: video.versionId, sourceStartMs: 0, sourceEndMs: 400 },
    ],
    subtitleFormat: 'none',
    subtitleText: '',
    subtitleVersionId: null,
    effects: {
      transition: 'none',
      transitionDurationMs: 300,
      musicFadeInMs: 0,
      musicFadeOutMs: 0,
      voiceFadeInMs: 0,
      voiceFadeOutMs: 0,
    },
  }
  try {
    for (const fit of ['contain', 'cover', 'blur']) {
      const job = await invoke('start_export', {
        draft: { ...draft, fit },
        outputPath: path.join(profile, `review-${fit}.mp4`),
      })
      await expect
        .poll(
          async () => {
            const value = (
              await invoke('list_export_jobs', { workflowId: workflow.id })
            ).find((j) => j.id === job.id)
            if (value?.status === 'failed') throw new Error(value.message)
            return value?.status
          },
          { timeout: 60000 },
        )
        .toBe('succeeded')
      const frame = execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          job.outputPath,
          '-ss',
          '0.2',
          '-vf',
          'scale=72:128',
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          'pipe:1',
        ],
        { windowsHide: true },
      )
      const top = frame.subarray(72 * 8 * 3, 72 * 12 * 3)
      const mean = [...top].reduce((s, v) => s + v, 0) / top.length
      if (fit === 'contain') expect(mean).toBeLessThan(2)
      else expect(mean).toBeGreaterThan(4)
      const pcm = execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-i',
          job.outputPath,
          '-vn',
          '-f',
          's16le',
          '-ac',
          '1',
          '-ar',
          '8000',
          'pipe:1',
        ],
        { windowsHide: true },
      )
      const rms = (start, end) => {
        let sum = 0,
          n = 0
        for (
          let i = Math.floor(start * 8000);
          i < Math.min(pcm.length / 2, Math.floor(end * 8000));
          i++
        ) {
          sum += (pcm.readInt16LE(i * 2) / 32768) ** 2
          n++
        }
        return Math.sqrt(sum / Math.max(1, n))
      }
      expect(rms(0.55, 0.9)).toBeLessThan(0.005)
      expect(rms(0.05, 0.35)).toBeGreaterThan(0.005)
    }
    await expect(
      invoke('start_export', {
        draft: {
          ...draft,
          voiceCues: [
            { ...draft.voiceCues[0], sourceEndMs: audio.durationMs + 1 },
          ],
        },
        outputPath: path.join(profile, 'invalid-cue.mp4'),
      }),
    ).rejects.toThrow(/配音分句/)
  } finally {
    await invoke('save_composition', { draft: previous })
  }
  console.log(
    'PASS: native contain/cover/blur exports and pixel fill; speech segment trim, silence tail, invalid source bounds and original draft restore. Local media only.',
  )
}
