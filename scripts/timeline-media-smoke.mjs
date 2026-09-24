import { execFileSync } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'

export async function testTimelineMedia(page, root, profile) {
  function probe(file) {
    return JSON.parse(
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
        { encoding: 'utf8' },
      ),
    )
  }
  await page
    .getByTestId('rf__node-timeline-fixture')
    .locator('.node-mark')
    .click()
  await page.getByRole('button', { name: '汇集已导出成片' }).click()
  await page.getByRole('button', { name: '开始执行' }).click()
  await expect(page.locator('.run-history > details').first()).toContainText(
    '等待导出',
  )
  await page.getByRole('button', { name: '时间线与导出', exact: true }).click()
  await expect(page.getByRole('heading', { name: '成片合成' })).toBeVisible()
  await page.getByRole('button', { name: '添加到时间线' }).click()
  await page.getByLabel('片段 1 开始').fill('0.1')
  await page.getByLabel('片段 1 结束').fill('0.8')
  await page.getByLabel('片段 1 字幕').fill('Hello from Frame Studio')
  await page.getByLabel('导出画幅').selectOption('1:1')
  await page
    .getByLabel('导入音频')
    .setInputFiles(path.join(root, 'tests/fixtures/music.wav'))
  await expect(page.getByLabel('背景音乐')).toContainText('music.wav')
  await page
    .getByLabel('导入音频')
    .setInputFiles(path.join(root, 'tests/fixtures/voice.wav'))
  await expect(page.getByLabel('配音')).toContainText('voice.wav')
  await page.getByLabel('背景音乐').selectOption({ label: 'music.wav' })
  await page.getByLabel('配音').selectOption({ label: 'voice.wav' })
  await page.getByRole('button', { name: '选择位置并导出 MP4' }).click()
  const exportRecord = page.locator('.timeline-export').first()
  await expect(exportRecord).toContainText('已完成', { timeout: 60000 })
  await expect(exportRecord).toContainText('finished.mp4')
  const mp4 = path.join(profile, 'finished.mp4')
  const cover = path.join(profile, 'finished.cover.jpg')
  await access(mp4)
  await access(cover)
  const header = await readFile(mp4)
  expect(header.subarray(4, 8).toString()).toBe('ftyp')
  const first = probe(mp4)
  const video = first.streams.find((stream) => stream.codec_type === 'video')
  const audio = first.streams.find((stream) => stream.codec_type === 'audio')
  expect(video?.width).toBe(720)
  expect(video?.height).toBe(720)
  expect(video?.codec_name).toBe('h264')
  expect(audio?.codec_name).toBe('aac')
  expect(Number(first.format.duration)).toBeGreaterThan(0.55)
  expect(Number(first.format.duration)).toBeLessThan(0.9)
  await page.getByLabel('导出画幅').selectOption('9:16')
  await page.getByLabel('导出分辨率').selectOption('1080')
  await page.getByLabel('导入字幕文件').setInputFiles({
    name: 'captions.vtt',
    mimeType: 'text/vtt',
    buffer: Buffer.from(
      'WEBVTT\n\n00:00:00.000 --> 00:00:00.700\nSecond export\n',
    ),
  })
  await expect(page.getByText('已导入 VTT 字幕')).toBeVisible()
  await page.getByRole('button', { name: '选择位置并导出 MP4' }).click()
  await expect(
    page.locator('.timeline-export').filter({ hasText: 'finished-2.mp4' }),
  ).toContainText('已完成', { timeout: 60000 })
  const second = probe(path.join(profile, 'finished-2.mp4'))
  expect(
    second.streams.find((stream) => stream.codec_type === 'video'),
  ).toMatchObject({ width: 1080, height: 1920 })
  await access(path.join(profile, 'finished-2.cover.jpg'))
  await page.getByLabel('导出画幅').selectOption('16:9')
  await page.getByLabel('导出分辨率').selectOption('720')
  await page.getByRole('button', { name: '改用片段字幕' }).click()
  await page.getByLabel('背景音乐').selectOption('')
  await page.getByLabel('配音').selectOption('')
  await page.getByRole('button', { name: '选择位置并导出 MP4' }).click()
  await expect(
    page.locator('.timeline-export').filter({ hasText: 'finished-3.mp4' }),
  ).toContainText('已完成', { timeout: 60000 })
  const third = probe(path.join(profile, 'finished-3.mp4'))
  expect(
    third.streams.find((stream) => stream.codec_type === 'video'),
  ).toMatchObject({ width: 1280, height: 720 })
  expect(third.streams.some((stream) => stream.codec_type === 'audio')).toBe(
    false,
  )
  await access(path.join(profile, 'finished-3.cover.jpg'))
  await page.reload()
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByRole('button', { name: '时间线与导出', exact: true }).click()
  await expect(page.getByLabel('片段 1 开始')).toHaveValue('0.1')
  await expect(page.getByLabel('片段 1 结束')).toHaveValue('0.8')
  await expect(page.locator('.timeline-export').first()).toContainText(
    'finished-3.mp4',
  )
  await page
    .getByTestId('rf__node-timeline-fixture')
    .locator('.node-mark')
    .click()
  await page.getByRole('button', { name: '汇集已导出成片' }).click()
  await page.getByRole('button', { name: '开始执行' }).click()
  await expect(page.locator('.node-inspector .output-preview')).toContainText(
    'MP4 已导出',
  )
  console.log(
    'PASS: persistent timeline; generated SRT and imported VTT; music and voice mix; 9:16, 16:9, 1:1 and 720p/1080p H.264 MP4; cover; canvas export node. Local fixture only.',
  )
}
