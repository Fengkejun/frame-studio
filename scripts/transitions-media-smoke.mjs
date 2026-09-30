import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'

async function invoke(page, command, args = {}) {
  return page.evaluate(
    ({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  )
}

export async function testTransitions(page, root, profile, fixture) {
  const original = (await invoke(page, 'list_workflows')).find((w) =>
    w.nodes.some((n) => n.id === 'timeline-fixture'),
  )
  const workflow = structuredClone(original)
  workflow.id = `transitions-${Date.now()}`
  workflow.name = '转场与声音效果验证'
  const storyboard = workflow.nodes.find((n) => n.kind === 'storyboard')
  storyboard.output.id = `transition-storyboard-${Date.now()}`
  const shot = storyboard.output.value.shots[0]
  storyboard.output.value.shots = ['red', 'blue', 'green'].map((color, i) => ({
    ...shot,
    id: `transition-${i}`,
    title: color,
  }))
  for (const node of workflow.nodes.filter((n) =>
    ['image', 'video', 'timeline'].includes(n.kind),
  ))
    node.output = null
  await invoke(page, 'save_workflow', { workflow })
  const images = await invoke(page, 'list_image_assets')
  const firstFrameVersionId = images[0].versionId
  fixture.setMode('success')
  await invoke(page, 'save_video_key', {
    region: 'singapore',
    apiKey: 'fixture-wan-key',
  })
  for (const [i, color] of ['red', 'blue', 'green'].entries()) {
    const bytes = execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=${color}:s=128x128:r=30:d=1.2`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      'frag_keyframe+empty_moov',
      '-f',
      'mp4',
      '-',
    ])
    fixture.setClip(bytes)
    const context = {
      workflowId: workflow.id,
      nodeId: storyboard.id,
      artifactId: storyboard.output.id,
      shotId: `transition-${i}`,
    }
    await invoke(page, 'select_first_frame', {
      context,
      versionId: firstFrameVersionId,
    })
    const job = await invoke(page, 'start_video_job', {
      request: {
        context,
        firstFrameVersionId,
        region: 'singapore',
        prompt: color,
        negativePrompt: '',
        duration: 2,
        resolution: '720P',
      },
    })
    await expect
      .poll(
        async () =>
          (
            await invoke(page, 'list_video_jobs', { workflowId: workflow.id })
          ).find((j) => j.id === job.id)?.status,
        { timeout: 20000 },
      )
      .toBe('succeeded')
    const asset = (
      await invoke(page, 'list_video_assets', { workflowId: workflow.id })
    ).find((a) => a.jobId === job.id)
    await invoke(page, 'select_video', { context, versionId: asset.versionId })
  }
  await invoke(page, 'clear_video_key', { region: 'singapore' })
  await page.reload()
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByLabel('切换工作流').selectOption(workflow.id)
  await page.getByRole('button', { name: '时间线与导出', exact: true }).click()
  await expect(page.getByRole('button', { name: '添加到时间线' })).toHaveCount(
    3,
  )
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: '添加到时间线' }).nth(i).click()
    await page.getByLabel(`片段 ${i + 1} 结束`).fill('1.2')
  }
  await page.getByLabel('导出画幅').selectOption('1:1')
  const tone = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:sample_rate=8000:duration=3',
    '-f',
    'wav',
    '-',
  ])
  await page.getByLabel('导入音频').setInputFiles({
    name: 'fade-tone.wav',
    mimeType: 'audio/wav',
    buffer: tone,
  })
  await expect(page.getByLabel('配音', { exact: true })).toContainText(
    'fade-tone.wav',
  )
  await page
    .getByLabel('配音', { exact: true })
    .selectOption({ label: 'fade-tone.wav' })
  await page.getByLabel('镜头转场', { exact: true }).selectOption('fade')
  await page.getByLabel('转场时长', { exact: true }).fill('0.8')
  await expect(
    page.locator('.timeline-effects').getByRole('alert'),
  ).toContainText('任一片段时长的一半')
  await expect(
    page.getByRole('button', { name: '选择位置并导出 MP4' }),
  ).toBeDisabled()
  await page.getByLabel('转场时长', { exact: true }).fill('0.3')
  await page.getByLabel('配音起点', { exact: true }).fill('0.2')
  await page.getByLabel('配音淡入', { exact: true }).fill('0.3')
  await page.getByLabel('配音淡出', { exact: true }).fill('3')
  await expect(
    page.locator('.timeline-effects').getByRole('alert'),
  ).toContainText('实际播放的配音时长')
  await page.getByLabel('配音淡出', { exact: true }).fill('0.3')
  await expect(page.locator('.timeline-effects')).toContainText(
    '当前成片 3.000 秒',
  )
  await expect(
    page.getByRole('img', { name: '配音波形', exact: true }),
  ).toBeVisible()
  await page.locator('.timeline-effects').scrollIntoViewIfNeeded()
  await page.screenshot({
    path: path.join(root, 'artifacts/desktop-timeline-effects.png'),
  })
  const getDraft = () =>
    invoke(page, 'get_composition', { workflowId: workflow.id })
  await expect.poll(getDraft).toMatchObject({
    effects: {
      transition: 'fade',
      transitionDurationMs: 300,
      voiceFadeInMs: 300,
      voiceFadeOutMs: 300,
    },
    voiceStartMs: 200,
  })
  const draft = await getDraft()
  const invalid = await invoke(page, 'start_export', {
    draft: {
      ...draft,
      effects: { ...draft.effects, transitionDurationMs: 800 },
    },
    outputPath: path.join(profile, 'guard.mp4'),
  }).catch(String)
  expect(invalid).toContain('任一片段时长的一半')
  await page.getByRole('button', { name: '选择位置并导出 MP4' }).click()
  await expect(
    page.locator('.timeline-export').filter({ hasText: 'finished-5.mp4' }),
  ).toContainText('已完成', { timeout: 60000 })
  const first = path.join(profile, 'finished-5.mp4')
  expect(
    Number(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'csv=p=0',
          first,
        ],
        { encoding: 'utf8' },
      ),
    ),
  ).toBeCloseTo(3, 1)
  const sample = (file, time) => [
    ...execFileSync('ffmpeg', [
      '-v',
      'error',
      '-ss',
      String(time),
      '-i',
      file,
      '-vf',
      'scale=1:1',
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ]),
  ]
  const middle = sample(first, 1.05)
  expect(middle[0]).toBeGreaterThan(60)
  expect(middle[2]).toBeGreaterThan(60)
  const secondBlend = sample(first, 1.95)
  expect(secondBlend[1]).toBeGreaterThan(25)
  expect(secondBlend[2]).toBeGreaterThan(60)
  const pcm = (file) =>
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      file,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '8000',
      '-f',
      's16le',
      '-',
    ])
  function rms(bytes, start, end) {
    let sum = 0
    let count = 0
    for (let i = Math.round(start * 8000); i < Math.round(end * 8000); i++) {
      sum += bytes.readInt16LE(i * 2) ** 2
      count++
    }
    return Math.sqrt(sum / count)
  }
  const voice = pcm(first)
  const steady = rms(voice, 0.7, 0.9)
  expect(rms(voice, 0.02, 0.14)).toBeLessThan(10)
  expect(rms(voice, 0.22, 0.27)).toBeLessThan(steady * 0.4)
  expect(rms(voice, 2.9, 2.97)).toBeLessThan(steady * 0.4)
  await page.getByLabel('镜头转场', { exact: true }).selectOption('fadeblack')
  await page.getByLabel('配音', { exact: true }).selectOption('')
  await page.getByLabel('背景音乐').selectOption({ label: 'fade-tone.wav' })
  await page.getByLabel('音乐淡入', { exact: true }).fill('0.3')
  await page.getByLabel('音乐淡出', { exact: true }).fill('0.3')
  await page.getByRole('button', { name: '选择位置并导出 MP4' }).click()
  await expect(
    page.locator('.timeline-export').filter({ hasText: 'finished-6.mp4' }),
  ).toContainText('已完成', { timeout: 60000 })
  const black = path.join(profile, 'finished-6.mp4')
  const blackFrames = execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    black,
    '-vf',
    'scale=1:1',
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    '-',
  ])
  const darkestTransitionFrame = Math.min(
    ...Array.from({ length: 10 }, (_, i) =>
      Math.max(...blackFrames.subarray((27 + i) * 3, (28 + i) * 3)),
    ),
  )
  expect(darkestTransitionFrame).toBeLessThan(15)
  const music = pcm(black)
  const musicSteady = rms(music, 0.7, 0.9)
  expect(rms(music, 0.02, 0.07)).toBeLessThan(musicSteady * 0.4)
  expect(rms(music, 2.9, 2.97)).toBeLessThan(musicSteady * 0.4)
  await writeFile(
    path.join(root, 'artifacts/transitions-export.mp4'),
    await readFile(black),
  )
  // Non-frame-aligned millisecond inputs must use the same 30 fps clock in UI and output.
  await page.getByLabel('背景音乐').selectOption('')
  for (let i = 1; i <= 3; i++)
    await page.getByLabel(`片段 ${i} 结束`).fill('1.19')
  await page.getByLabel('转场时长', { exact: true }).fill('0.333')
  await expect(page.locator('.timeline-effects')).toContainText(
    '当前成片 2.933 秒',
  )
  await page.getByRole('button', { name: '选择位置并导出 MP4' }).click()
  await expect(
    page.locator('.timeline-export').filter({ hasText: 'finished-7.mp4' }),
  ).toContainText('已完成', { timeout: 60000 })
  const fractional = JSON.parse(
    execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_streams',
        '-of',
        'json',
        path.join(profile, 'finished-7.mp4'),
      ],
      { encoding: 'utf8' },
    ),
  )
  expect(
    Number(fractional.streams.find((s) => s.codec_type === 'video').nb_frames),
  ).toBe(88)
  expect(fractional.streams.some((s) => s.codec_type === 'audio')).toBe(false)
  await page.reload()
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByRole('button', { name: '时间线与导出', exact: true }).click()
  await expect(page.getByLabel('镜头转场', { exact: true })).toHaveValue(
    'fadeblack',
  )
  await expect(page.getByLabel('音乐淡入', { exact: true })).toHaveValue('0.3')
  await expect(page.locator('.timeline-clips .timeline-clip')).toHaveCount(3)
  console.log(
    'PASS: three genuine selected video versions; chained dissolve and black transitions; compact duration and fractional frame clock; voice offset with fades; looped music fades; pixel/PCM validation; guards and reload. Local fixtures only.',
  )
}
