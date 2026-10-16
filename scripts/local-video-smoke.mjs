import { reloadFixtureProject } from './native-fixture-project.mjs'
import { execFileSync } from 'node:child_process'
import { open, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'

const invoke = (page, command, args = {}) =>
  page.evaluate(
    ({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  )

export async function testLocalVideo(page, root, profile) {
  const workflow = (await invoke(page, 'list_workflows')).find(
    (w) => w.name === '转场与声音效果验证',
  )
  const frame = (
    await invoke(page, 'list_first_frames', { workflowId: workflow.id })
  )[0]
  const before = await invoke(page, 'list_video_assets', {
    workflowId: workflow.id,
  })
  const source = path.join(profile, 'import-video.mp4')
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=24',
      '-t',
      '1.25',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-an',
      '-movflags',
      '+faststart',
      source,
    ],
    { windowsHide: true },
  )
  const valid = await readFile(source)
  // A legitimate free MP4 box creates a file above the old 64 MB cap.
  const file = await open(source, 'r+')
  const padding = 70 * 1024 * 1024
  const box = Buffer.alloc(8)
  box.writeUInt32BE(padding)
  box.write('free', 4)
  await file.write(box, 0, box.length, valid.length)
  await file.truncate(valid.length + padding)
  await file.close()
  await page.getByRole('button', { name: '镜头视频', exact: true }).click()
  await page
    .getByLabel('视频目标镜头')
    .selectOption(`${frame.context.nodeId}/${frame.context.shotId}`)
  await page.getByRole('button', { name: '导入本地视频', exact: true }).click()
  const imported = page
    .locator('.video-candidates .asset-card')
    .filter({ hasText: '本地导入 · import-video.mp4' })
  await expect(imported).toHaveCount(1)
  await expect(imported).toContainText('1.25 秒')
  await expect(imported).toContainText('320 × 180 · 24.00 fps')
  await expect(imported).toContainText('70.0 MB')
  const assets = await invoke(page, 'list_video_assets', {
    workflowId: workflow.id,
  })
  expect(assets).toHaveLength(before.length + 1)
  const entry = assets.find((a) => a.source === 'import')
  expect(entry.metadata).toMatchObject({
    durationMs: 1250,
    width: 320,
    height: 180,
    fps: 24,
    codec: 'h264',
  })
  expect(entry.bytes).toBeGreaterThan(64 * 1024 * 1024)
  expect(
    (
      await invoke(page, 'list_selected_videos', { workflowId: workflow.id })
    ).some((s) => s.versionId === entry.versionId),
  ).toBe(false)
  await imported.getByRole('button', { name: '播放片段' }).click()
  const player = page.getByLabel('镜头视频预览')
  await expect(player).toHaveAttribute('src', /http:\/\/asset\.localhost\//)
  await expect
    .poll(() => player.evaluate((v) => v.readyState))
    .toBeGreaterThanOrEqual(2)
  expect(await player.evaluate((v) => v.videoWidth)).toBe(320)
  await player.evaluate(async (v) => {
    v.muted = true
    await v.play()
  })
  await expect
    .poll(() => player.evaluate((v) => v.currentTime))
    .toBeGreaterThan(0.1)
  await player.evaluate((v) => {
    v.pause()
    v.currentTime = 0.9
  })
  await expect
    .poll(() =>
      player.evaluate(
        (v) => !v.seeking && v.readyState >= 2 && v.currentTime >= 0.9,
      ),
    )
    .toBe(true)
  await page.getByRole('button', { name: '关闭预览', exact: true }).click()
  await imported.getByRole('button', { name: '选为镜头片段' }).click()
  await expect(imported).toContainText('✓ 当前片段')
  // Invalid data and an audio-only MP4 must leave no partial asset or changed selection.
  const arguments_ = {
    context: frame.context,
    firstFrameVersionId: frame.versionId,
  }
  const rejection = () =>
    invoke(page, 'import_video', arguments_).then(
      () => 'unexpected success',
      String,
    )
  await writeFile(source, Buffer.alloc(20, 0))
  expect(await rejection()).toContain('有效 MP4')
  await writeFile(source, valid)
  const stale = await invoke(page, 'import_video', {
    ...arguments_,
    firstFrameVersionId: 'stale',
  }).then(() => 'unexpected success', String)
  expect(stale).toContain('首帧已变化')
  const audioOnly = path.join(profile, 'audio-only.mp4')
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-c:a',
      'aac',
      audioOnly,
    ],
    { windowsHide: true },
  )
  await writeFile(source, await readFile(audioOnly))
  expect(await rejection()).toContain('视频流')
  expect(
    await invoke(page, 'list_video_assets', { workflowId: workflow.id }),
  ).toHaveLength(before.length + 1)
  expect(
    (await readdir(path.join(profile, 'assets'))).some((f) =>
      f.endsWith('.partial'),
    ),
  ).toBe(false)
  await reloadFixtureProject(page)
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByRole('button', { name: '镜头视频', exact: true }).click()
  await page
    .getByLabel('视频目标镜头')
    .selectOption(`${frame.context.nodeId}/${frame.context.shotId}`)
  await expect(imported).toContainText('✓ 当前片段')
  await page
    .locator('.video-candidates')
    .screenshot({ path: path.join(root, 'artifacts/local-video-import.png') })
  await page.getByRole('button', { name: '时间线与导出', exact: true }).click()
  await expect(page.locator('.timeline-clip')).toHaveCount(3)
  // Replace the previous timeline through visible controls, then use the imported version.
  while (await page.locator('.timeline-clip').count())
    await page
      .locator('.timeline-clip')
      .first()
      .getByRole('button', { name: '移除', exact: true })
      .click()
  await page
    .locator('.timeline-choice')
    .filter({ hasText: entry.versionId.slice(0, 8) })
    .getByRole('button', { name: '添加到时间线' })
    .click()
  await expect(page.getByLabel('片段 1 结束')).toHaveValue('1.25')
  await page.getByLabel('配音', { exact: true }).selectOption('')
  await page.getByLabel('背景音乐').selectOption('')
  await page.getByRole('button', { name: '选择位置并导出 MP4' }).click()
  await expect(
    page.locator('.timeline-export').filter({ hasText: 'finished-10.mp4' }),
  ).toContainText('已完成', { timeout: 60000 })
  // A long source can be trimmed after the first minute, while each clip remains <=60 s.
  const longSource = path.join(profile, 'long-source.mp4')
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=320x180:rate=1',
      '-t',
      '65',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-an',
      longSource,
    ],
    { windowsHide: true },
  )
  await writeFile(source, await readFile(longSource))
  await page.getByRole('button', { name: '镜头视频', exact: true }).click()
  await page.getByRole('button', { name: '导入本地视频', exact: true }).click()
  const longCard = page
    .locator('.video-candidates .asset-card')
    .filter({ hasText: '65.00 秒' })
  await expect(longCard).toBeVisible()
  await longCard.getByRole('button', { name: '选为镜头片段' }).click()
  const longEntry = (
    await invoke(page, 'list_video_assets', { workflowId: workflow.id })
  ).find((a) => a.metadata?.durationMs === 65000)
  await page.getByRole('button', { name: '时间线与导出', exact: true }).click()
  await page
    .locator('.timeline-clip')
    .first()
    .getByRole('button', { name: '移除', exact: true })
    .click()
  await page
    .locator('.timeline-choice')
    .filter({ hasText: longEntry.versionId.slice(0, 8) })
    .getByRole('button', { name: '添加到时间线' })
    .click()
  await expect(page.getByLabel('片段 1 结束')).toHaveValue('60')
  await expect(page.getByLabel('片段 1 结束')).toHaveAttribute('max', '65')
  await page.getByLabel('片段 1 开始').fill('64')
  await page.getByLabel('片段 1 结束').fill('65')
  await page.getByRole('button', { name: '选择位置并导出 MP4' }).click()
  await expect(
    page.locator('.timeline-export').filter({ hasText: 'finished-11.mp4' }),
  ).toContainText('已完成', { timeout: 60000 })
  console.log(
    'PASS: native local video import, actual metadata, >64 MB playback/seeking, explicit selection, corrupt/audio-only/stale guards, cleanup, reload and real exports including a trim after 60 seconds. Local media only.',
  )
}
