import path from 'node:path'
import { readFile, access } from 'node:fs/promises'
import { expect } from '@playwright/test'

const invoke = (page, command, args = {}) =>
  page.evaluate(
    ({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  )
export async function testStorage(page, root, profile) {
  const workflow = (await invoke(page, 'list_workflows')).find(
    (w) => w.name === '转场与声音效果验证',
  )
  const args = { workflowId: workflow.id }
  const frames = await invoke(page, 'list_first_frames', args)
  const clips = await invoke(page, 'list_selected_videos', args)
  const draft = await invoke(page, 'get_composition', args)
  const bytes = [
    ...(await readFile(path.join(root, 'src-tauri/icons/128x128@2x.png'))),
  ]
  const unused = await invoke(page, 'import_image', {
    name: '清理测试闲置.png',
    bytes,
  })
  const race = await invoke(page, 'import_image', {
    name: '清理测试引用变化.png',
    bytes,
  })
  const original = await readFile(path.join(profile, 'assets', unused.fileName))
  const thumb = await readFile(
    path.join(profile, 'assets', `${unused.versionId}.thumb.png`),
  )
  const total = original.length + thumb.length
  const baseline = await invoke(page, 'get_storage_report')
  expect(baseline.candidates.some((i) => i.id === frames[0].versionId)).toBe(
    false,
  )
  expect(
    await invoke(page, 'trash_assets', { ids: [frames[0].versionId] }).then(
      () => '',
      String,
    ),
  ).toContain('已有引用')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const panel = page.getByRole('region', { name: '素材与存储', exact: true })
  await panel.getByLabel('选择素材 清理测试引用变化.png').check()
  await panel.getByRole('button', { name: '预览清理计划', exact: true }).click()
  const move = panel.getByRole('button', {
    name: '确认移入回收区',
    exact: true,
  })
  await expect(move).toBeDisabled()
  await invoke(page, 'set_role_reference', {
    ...args,
    roleName: '清理保护验证',
    versionId: race.versionId,
  })
  await panel.getByLabel('已核对清理列表').check()
  await move.click()
  await expect(panel.getByRole('alert')).toContainText('已有引用')
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  expect(
    (await invoke(page, 'list_image_assets')).some(
      (i) => i.versionId === race.versionId,
    ),
  ).toBe(true)
  await panel.getByLabel('选择素材 清理测试闲置.png').check()
  await panel.getByRole('button', { name: '预览清理计划', exact: true }).click()
  await panel.getByLabel('已核对清理列表').check()
  await move.click()
  const recycled = panel
    .locator('.storage-trash-row')
    .filter({ hasText: '清理测试闲置.png' })
  await expect(recycled).toHaveCount(1)
  const afterMove = await invoke(page, 'get_storage_report')
  expect(afterMove.trashBytes - baseline.trashBytes).toBe(total)
  expect(afterMove.assetBytes + afterMove.trashBytes).toBe(
    baseline.assetBytes + baseline.trashBytes,
  )
  expect(
    (await invoke(page, 'list_image_assets')).some(
      (i) => i.versionId === unused.versionId,
    ),
  ).toBe(false)
  expect(
    await access(path.join(profile, 'assets', unused.fileName)).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  await recycled.getByRole('button', { name: '恢复素材', exact: true }).click()
  await expect(recycled).toHaveCount(0)
  expect(await readFile(path.join(profile, 'assets', unused.fileName))).toEqual(
    original,
  )
  expect(
    await readFile(
      path.join(profile, 'assets', `${unused.versionId}.thumb.png`),
    ),
  ).toEqual(thumb)
  await invoke(page, 'trash_assets', { ids: [unused.versionId] })
  const entry = (await invoke(page, 'get_storage_report')).trash.find(
    (i) => i.name === unused.name,
  )
  expect(
    await invoke(page, 'purge_trash', { id: entry.id, confirmed: false }).then(
      () => '',
      String,
    ),
  ).toContain('确认永久删除')
  await panel.getByRole('button', { name: '刷新占用统计', exact: true }).click()
  await recycled.getByRole('button', { name: '永久删除…', exact: true }).click()
  await expect(
    panel.getByRole('button', { name: '确认永久删除', exact: true }),
  ).toBeDisabled()
  await panel.getByRole('button', { name: '取消', exact: true }).click()
  expect((await invoke(page, 'get_storage_report')).trash).toHaveLength(
    afterMove.trash.length,
  )
  await recycled.getByRole('button', { name: '永久删除…', exact: true }).click()
  await panel.getByLabel('确认永久删除这些回收文件').check()
  await panel.getByRole('button', { name: '确认永久删除', exact: true }).click()
  await expect(recycled).toHaveCount(0)
  const after = await invoke(page, 'get_storage_report')
  expect(after.assetBytes + after.trashBytes).toBe(
    baseline.assetBytes + baseline.trashBytes - total,
  )
  const audio = await invoke(page, 'import_audio', {
    ...args,
    name: '清理音频恢复.wav',
    bytes: [...(await readFile(path.join(root, 'tests/fixtures/voice.wav')))],
  })
  const candidates = (await invoke(page, 'get_storage_report')).candidates
  const videos = await invoke(page, 'list_video_assets', args)
  const video = videos.find((v) =>
    candidates.some((i) => i.kind === 'video' && i.id === v.versionId),
  )
  expect(video).toBeTruthy()
  for (const asset of [audio, video]) {
    const originalBytes = await readFile(
      path.join(profile, 'assets', asset.fileName),
    )
    const existing = new Set(
      (await invoke(page, 'get_storage_report')).trash.map((i) => i.id),
    )
    await invoke(page, 'trash_assets', { ids: [asset.versionId] })
    const journal = (await invoke(page, 'get_storage_report')).trash.find(
      (i) => !existing.has(i.id),
    )
    expect(
      await access(path.join(profile, 'assets', asset.fileName)).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
    await invoke(page, 'restore_trash', { id: journal.id })
    expect(
      await readFile(path.join(profile, 'assets', asset.fileName)),
    ).toEqual(originalBytes)
  }
  expect(await invoke(page, 'list_first_frames', args)).toEqual(frames)
  expect(await invoke(page, 'list_selected_videos', args)).toEqual(clips)
  expect(await invoke(page, 'get_composition', args)).toEqual(draft)
  expect(
    await invoke(page, 'image_preview', { versionId: frames[0].versionId }),
  ).toMatch(/^data:image\/png;base64,/)
  await page.screenshot({
    path: path.join(root, 'artifacts/storage-cleanup.png'),
    fullPage: true,
  })
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  console.log(
    'PASS: real storage IPC, occupancy bytes, protected/stale-reference guards, explicit quarantine/restore/purge, original bytes and version choices retained. Isolated fixture data only.',
  )
}
