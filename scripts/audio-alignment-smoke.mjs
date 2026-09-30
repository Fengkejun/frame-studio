import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { expect } from '@playwright/test'

export async function testWaveform(page, root) {
  const workflowId = await page.evaluate(async () => {
    const workflows =
      await globalThis.__TAURI_INTERNALS__.invoke('list_workflows')
    return workflows.find((w) =>
      w.nodes.some((n) => n.id === 'timeline-fixture'),
    ).id
  })
  // One second of PCM: silence followed by a half-amplitude tone.
  const wav = Buffer.alloc(44 + 8000 * 2)
  wav.write('RIFF')
  wav.writeUInt32LE(wav.length - 8, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24)
  wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(16000, 40)
  for (let i = 4000; i < 8000; i++)
    wav.writeInt16LE(
      Math.round(16384 * Math.sin((2 * Math.PI * 1000 * i) / 8000)),
      44 + i * 2,
    )
  await page.getByLabel('导入音频').setInputFiles({
    name: 'waveform-envelope.wav',
    mimeType: 'audio/wav',
    buffer: wav,
  })
  await expect(page.getByLabel('背景音乐')).toContainText(
    'waveform-envelope.wav',
  )
  const wave = await page.evaluate(async (id) => {
    const assets = await globalThis.__TAURI_INTERNALS__.invoke(
      'list_audio_assets',
      { workflowId: id },
    )
    return globalThis.__TAURI_INTERNALS__.invoke('get_audio_waveform', {
      versionId: assets.find((a) => a.name === 'waveform-envelope.wav')
        .versionId,
    })
  }, workflowId)
  expect(wave.durationMs).toBe(1000)
  expect(wave.peaks).toHaveLength(512)
  expect(wave.peaks.slice(0, 250).every((p) => p === 0)).toBe(true)
  expect(wave.peaks.slice(260).every((p) => p > 0.45 && p <= 0.51)).toBe(true)
  await expect(
    page.getByRole('img', { name: '配音波形', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('img', { name: '音乐波形', exact: true }),
  ).toBeVisible()
  await page.getByLabel('配音起点', { exact: true }).fill('0.7')
  await expect(
    page.locator('.audio-alignment').getByRole('alert'),
  ).toContainText('未保存此输入')
  await page.getByLabel('配音起点', { exact: true }).fill('0.2')
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          globalThis.__TAURI_INTERNALS__.invoke('get_composition', {
            workflowId: id,
          }),
        workflowId,
      ),
    )
    .toMatchObject({ voiceStartMs: 200 })
  const guard = await page.evaluate(async (id) => {
    const draft = await globalThis.__TAURI_INTERNALS__.invoke(
      'get_composition',
      { workflowId: id },
    )
    try {
      await globalThis.__TAURI_INTERNALS__.invoke('start_export', {
        draft: { ...draft, voiceStartMs: 700 },
        outputPath: 'unused.mp4',
      })
      return ''
    } catch (reason) {
      return String(reason)
    }
  }, workflowId)
  expect(guard).toContain('配音起点须早于成片结束时间')
  await page.setViewportSize({ width: 960, height: 640 })
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true)
  await page.setViewportSize({ width: 1360, height: 900 })
  await page.locator('.audio-alignment').scrollIntoViewIfNeeded()
  await page.screenshot({
    path: path.join(root, 'artifacts/desktop-audio-alignment.png'),
  })
  await page.getByRole('button', { name: '配音回到起点' }).click()
  await expect(page.getByLabel('配音起点', { exact: true })).toHaveValue('0')
  return workflowId
}

export async function testAlignedExport(
  page,
  root,
  profile,
  workflowId,
  sourceDraft,
) {
  await page
    .getByLabel('配音', { exact: true })
    .selectOption(sourceDraft.voiceVersionId)
  await page
    .getByLabel('字幕版本预览')
    .selectOption(sourceDraft.subtitleVersionId)
  await page
    .getByRole('button', { name: '应用字幕到时间线', exact: true })
    .click()
  await page.getByLabel('配音起点', { exact: true }).fill('0.2')
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          globalThis.__TAURI_INTERNALS__.invoke('get_composition', {
            workflowId: id,
          }),
        workflowId,
      ),
    )
    .toMatchObject({
      voiceStartMs: 200,
      subtitleVersionId: sourceDraft.subtitleVersionId,
    })
  const srt = await page.evaluate(
    (versionId) =>
      globalThis.__TAURI_INTERNALS__.invoke('get_subtitle_srt', {
        versionId,
        offsetMs: 200,
        timelineDurationMs: 700,
      }),
    sourceDraft.subtitleVersionId,
  )
  expect(srt).toBe(
    '1\n00:00:00,250 --> 00:00:00,700\nHello corrected captions\n\n',
  )
  const original = await page.evaluate(
    (versionId) =>
      globalThis.__TAURI_INTERNALS__.invoke('get_subtitle_srt', { versionId }),
    sourceDraft.subtitleVersionId,
  )
  expect(original).toBe(sourceDraft.subtitleText)
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载 SRT', exact: true }).click()
  const downloaded = await download
  await downloaded.saveAs(path.join(root, 'artifacts/aligned-subtitles.srt'))
  await page.getByRole('button', { name: '选择位置并导出 MP4' }).click()
  await expect(
    page.locator('.timeline-export').filter({ hasText: 'finished-4.mp4' }),
  ).toContainText('已完成', { timeout: 60000 })
  const file = path.join(profile, 'finished-4.mp4')
  const pcm = execFileSync('ffmpeg', [
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
  function rms(start, end) {
    let sum = 0
    let count = 0
    for (
      let i = Math.floor(start * 8000);
      i < Math.min(Math.floor(end * 8000), pcm.length / 2);
      i++
    ) {
      sum += pcm.readInt16LE(i * 2) ** 2
      count++
    }
    return Math.sqrt(sum / count)
  }
  expect(rms(0.02, 0.16)).toBeLessThan(10)
  expect(rms(0.3, 0.5)).toBeGreaterThan(100)
  function contrast(time) {
    const pixels = execFileSync('ffmpeg', [
      '-v',
      'error',
      '-ss',
      String(time),
      '-i',
      file,
      '-vf',
      'crop=iw:ih/4:0:3*ih/4',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-',
    ])
    let min = 255
    let max = 0
    for (const p of pixels) {
      min = Math.min(min, p)
      max = Math.max(max, p)
    }
    return max - min
  }
  expect(contrast(0.1)).toBeLessThan(40)
  expect(contrast(0.35)).toBeGreaterThan(128)
  console.log(
    'PASS: bounded native PCM waveform; offset validation; shifted/clipped SRT download; unchanged source subtitle; MP4 leading silence and delayed voice; subtitle onset follows voice.',
  )
}
