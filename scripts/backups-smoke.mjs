import path from 'node:path'
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import { expect } from '@playwright/test'

const invoke = (page, command, args = {}) =>
  page.evaluate(
    ({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  )

export async function testBackups(page, profile, backupDirectory) {
  await mkdir(backupDirectory, { recursive: true })
  const source = (await invoke(page, 'list_workflows')).find(
    (w) => w.name === '转场与声音效果验证',
  )
  expect(source).toBeTruthy()
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByLabel('切换工作流').selectOption(source.id)
  await page.getByText('项目备份与恢复', { exact: true }).click()
  const panel = page.getByRole('region', { name: '项目备份与恢复' })
  await panel.getByRole('button', { name: '选择备份位置' }).click()
  await expect(panel).toContainText('FrameStudioBackups')
  await panel.getByRole('button', { name: '备份当前项目', exact: true }).click()
  await expect(panel).toContainText('备份已完成：', { timeout: 30000 })
  await expect(
    panel.getByRole('button', { name: '备份当前项目', exact: true }),
  ).toBeEnabled()
  const first = (await invoke(page, 'list_project_backups')).points[0]
  expect(first.fileCount).toBeGreaterThan(3)
  expect(first.newBytes).toBeGreaterThan(0)
  const repository = path.join(backupDirectory, 'FrameStudioBackups')
  const objects = (await readdir(path.join(repository, 'objects'))).sort()
  const second = await invoke(page, 'create_project_backup', {
    workflowId: source.id,
  })
  expect(second.newBytes).toBe(0)
  expect(second.reusedBytes).toBe(second.totalBytes)
  expect((await readdir(path.join(repository, 'objects'))).sort()).toEqual(
    objects,
  )
  const originalDraft = await invoke(page, 'get_composition', {
    workflowId: source.id,
  })
  const originalFrames = await invoke(page, 'list_first_frames', {
    workflowId: source.id,
  })
  const manifest = JSON.parse(
    await readFile(
      path.join(repository, 'snapshots', `${first.id}.json`),
      'utf8',
    ),
  )
  expect(
    manifest.manifest.snapshot.workflow.nodes.every(
      (n) => n.config.providerId === '',
    ),
  ).toBe(true)
  expect(
    manifest.manifest.snapshot.exports.every((job) =>
      job.outputPath.startsWith('exports/'),
    ),
  ).toBe(true)
  const damagedFile = path.join(
    repository,
    'objects',
    manifest.manifest.files[0].sha256,
  )
  const preserved = await readFile(damagedFile)
  const before = (await invoke(page, 'list_workflows')).length
  await writeFile(damagedFile, Buffer.alloc(preserved.length, 0))
  const rejected = await invoke(page, 'restore_project_backup', {
    backupId: first.id,
  }).then(() => '', String)
  expect(rejected).toContain('校验')
  expect((await invoke(page, 'list_workflows')).length).toBe(before)
  await writeFile(damagedFile, preserved)
  await panel.getByRole('button', { name: '刷新备份记录' }).click()
  await panel.getByLabel('备份记录').selectOption(first.id)
  await page.screenshot({
    path: path.join(path.dirname(profile), 'desktop-backups.png'),
  })
  await panel.getByRole('button', { name: '恢复为新项目' }).click()
  await expect(page.getByLabel('工作流名称')).toHaveValue(
    '转场与声音效果验证 · 恢复副本',
    { timeout: 30000 },
  )
  const restored = (await invoke(page, 'list_workflows')).find(
    (w) => w.name === '转场与声音效果验证 · 恢复副本',
  )
  expect(restored.id).not.toBe(source.id)
  const args = { workflowId: restored.id }
  const frames = await invoke(page, 'list_first_frames', args)
  const videos = await invoke(page, 'list_selected_videos', args)
  const draft = await invoke(page, 'get_composition', args)
  expect(frames.length).toBe(originalFrames.length)
  expect(frames[0].versionId).not.toBe(originalFrames[0].versionId)
  expect(videos.map((v) => v.versionId)).toEqual(
    expect.arrayContaining(draft.clips.map((c) => c.versionId)),
  )
  expect(draft.voiceStartMs).toBe(originalDraft.voiceStartMs)
  expect(draft.effects).toEqual(originalDraft.effects)
  expect(draft.clips.map((c) => c.caption)).toEqual(
    originalDraft.clips.map((c) => c.caption),
  )
  const assets = await invoke(page, 'list_video_assets', args)
  for (const clip of draft.clips) {
    expect(assets.some((asset) => asset.versionId === clip.versionId)).toBe(
      true,
    )
    expect(
      (await readFile(path.join(profile, 'assets', `${clip.versionId}.mp4`)))
        .length,
    ).toBeGreaterThan(0)
  }
  expect(
    await invoke(page, 'get_composition', { workflowId: source.id }),
  ).toEqual(originalDraft)
  await page.reload()
  await expect(page.getByRole('status')).toHaveText('桌面连接正常')
  expect((await invoke(page, 'list_project_backups')).points.length).toBe(2)
  console.log(
    `PASS: incremental backups reuse ${second.reusedBytes} bytes; corruption rejected; native UI restored a complete project copy.`,
  )
}
