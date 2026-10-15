import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'

// Local composition only: every input must already be a successful remote job.
export async function testLiveFilm(page, root, profile) {
  if (!process.env.FRAME_STUDIO_LIVE_FILM_REPORTS) return
  const files = JSON.parse(process.env.FRAME_STUDIO_LIVE_FILM_REPORTS)
  assert.equal(files.length, 3, 'Choose exactly three completed shot reports.')
  const reports = await Promise.all(
    files.map(async (file) => JSON.parse(await readFile(file, 'utf8'))),
  )
  const workflowId = reports[0].workflowId
  for (const report of reports) {
    assert.equal(report.workflowId, workflowId)
    assert.equal(report.profile, profile)
    assert.equal(report.job.status, 'succeeded')
    assert.ok(report.job.taskId)
    assert.ok(report.asset?.metadata)
  }
  assert.equal(new Set(reports.map((r) => r.job.taskId)).size, 3)
  const invoke = (command, args = {}) =>
    page.evaluate(
      ({ command, args }) =>
        globalThis.__TAURI_INTERNALS__.invoke(command, args),
      { command, args },
    )
  const jobs = await invoke('list_video_jobs', { workflowId })
  const assets = await invoke('list_video_assets', { workflowId })
  for (const report of reports) {
    const current = jobs.find((job) => job.id === report.job.id)
    assert.equal(current?.status, 'succeeded')
    assert.equal(current.taskId, report.job.taskId)
    const asset = assets.find(
      (asset) => asset.versionId === report.asset.versionId,
    )
    assert.equal(asset?.jobId, current.id)
    assert.ok(asset.source.startsWith('wulusai-'))
    await invoke('select_video', {
      context: current.request.context,
      versionId: asset.versionId,
    })
  }
  const voicePath = process.env.FRAME_STUDIO_LIVE_FILM_VOICE
  assert.ok(
    voicePath,
    'Provide a local narration file for the film acceptance.',
  )
  const voice = await invoke('import_audio', {
    workflowId,
    name: path.basename(voicePath),
    bytes: [...(await readFile(voicePath))],
  })
  const music = await invoke('import_audio', {
    workflowId,
    name: 'acceptance-music.wav',
    bytes: [...(await readFile(path.join(root, 'tests/fixtures/music.wav')))],
  })
  const captions = [
    '湖面上的红纸船',
    '缓缓靠近，涟漪轻漾',
    '小小的旅程，继续向前',
  ]
  const draft = {
    workflowId,
    clips: reports.map((report, index) => ({
      versionId: report.asset.versionId,
      trimStartMs: 0,
      trimEndMs: Math.min(4000, report.asset.metadata.durationMs),
      caption: captions[index],
    })),
    aspect: '16:9',
    resolution: 720,
    quality: 'balanced',
    musicVersionId: music.versionId,
    voiceVersionId: voice.versionId,
    voiceStartMs: 0,
    musicVolume: 12,
    subtitleVersionId: null,
    subtitleFormat: 'none',
    subtitleText: '',
    effects: {
      transition: 'fade',
      transitionDurationMs: 200,
      musicFadeInMs: 300,
      musicFadeOutMs: 300,
      voiceFadeInMs: 100,
      voiceFadeOutMs: 100,
    },
  }
  const expectedDuration =
    (draft.clips.reduce((total, clip) => total + clip.trimEndMs, 0) - 400) /
    1000
  assert.ok(voice.durationMs <= expectedDuration * 1000)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outputPath = path.join(root, 'artifacts', `sd-three-shot-${stamp}.mp4`)
  await invoke('save_composition', { draft })
  const started = await invoke('start_export', { draft, outputPath })
  let job
  await expect
    .poll(
      async () => {
        job = (await invoke('list_export_jobs', { workflowId })).find(
          (item) => item.id === started.id,
        )
        return job?.status
      },
      { timeout: 120000 },
    )
    .toBe('succeeded')
  const probe = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        outputPath,
      ],
      { encoding: 'utf8', windowsHide: true },
    ),
  )
  const video = probe.streams.find((stream) => stream.codec_type === 'video')
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio')
  assert.equal(video.codec_name, 'h264')
  assert.equal(video.width, 1280)
  assert.equal(video.height, 720)
  assert.equal(audio.codec_name, 'aac')
  assert.ok(Math.abs(Number(probe.format.duration) - expectedDuration) < 0.15)
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-xerror', '-i', outputPath, '-f', 'null', '-'],
    {
      windowsHide: true,
    },
  )
  const samples = []
  for (const time of [1, 5, 9]) {
    const sample = outputPath.replace(/\.mp4$/, `-${time}s.png`)
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-ss',
        String(time),
        '-i',
        outputPath,
        '-frames:v',
        '1',
        sample,
      ],
      {
        windowsHide: true,
      },
    )
    samples.push(sample)
  }
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByLabel('切换工作流').selectOption(workflowId)
  await page.getByRole('button', { name: '时间线与导出', exact: true }).click()
  await page
    .getByRole('button', { name: '播放成片', exact: true })
    .first()
    .click()
  const player = page.getByLabel('成片播放器')
  await expect
    .poll(() => player.evaluate((el) => el.readyState))
    .toBeGreaterThanOrEqual(2)
  await player.evaluate(async (el) => {
    el.muted = true
    await el.play()
  })
  await expect
    .poll(() => player.evaluate((el) => el.currentTime))
    .toBeGreaterThan(0)
  const playback = await player.evaluate((el) => ({
    duration: el.duration,
    width: el.videoWidth,
    height: el.videoHeight,
    currentTime: el.currentTime,
  }))
  await player.evaluate((el) => el.pause())
  await writeFile(
    outputPath.replace(/\.mp4$/, '.json'),
    JSON.stringify(
      {
        workflowId,
        profile,
        generationPosts: 0,
        sources: reports.map((report) => ({
          taskId: report.job.taskId,
          mode: report.mode,
          asset: report.asset,
        })),
        voice: { source: 'local imported narration', asset: voice },
        music: { source: 'local test fixture', asset: music },
        export: job,
        probe,
        playback,
        samples,
        billing:
          'Actual provider charges still require statement reconciliation.',
      },
      null,
      2,
    ),
  )
  console.log(
    `PASS: three real cloud shots, local narration/music, captions, dissolve, decoded H.264/AAC export and native playback: ${outputPath}`,
  )
}
