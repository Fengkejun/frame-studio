import { expect, test } from '@playwright/test'

test('backups save edits, retain the location on cancellation, and preserve projects on restore errors', async ({
  page,
}) => {
  await page.addInitScript(() => {
    let directory: string | null = null
    let chooseCount = 0
    let restoreCount = 0
    const points: unknown[] = []
    let saved: Record<string, unknown> = {}
    const calls: string[] = []
    Object.assign(globalThis, {
      backupFixtureCalls: calls,
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: (command: string, args: Record<string, unknown> = {}) => {
          calls.push(command)
          if (command === 'get_default_workflow') return Promise.resolve(null)
          if (command === 'set_default_workflow') return Promise.resolve()
          if (command === 'get_app_info')
            return Promise.resolve({
              name: 'Frame Studio',
              version: '0.1.0',
              platform: 'fixture',
              architecture: 'fixture',
            })
          if (command === 'save_workflow') {
            saved = structuredClone(args.workflow as Record<string, unknown>)
            return Promise.resolve()
          }
          if (command === 'list_project_backups')
            return Promise.resolve({ directory, points, warnings: [] })
          if (command === 'choose_backup_directory') {
            directory =
              ++chooseCount === 1 ? null : 'fixture/FrameStudioBackups'
            return Promise.resolve(directory)
          }
          if (command === 'create_project_backup')
            return new Promise((resolve) => {
              Object.assign(globalThis, {
                finishBackupFixture: () => {
                  const point = {
                    id: 'backup-1',
                    workflowId: saved.id,
                    projectName: saved.name,
                    createdAt: Date.now(),
                    fileCount: 2,
                    totalBytes: 8192,
                    newBytes: 4096,
                    reusedBytes: 4096,
                  }
                  points.push(point)
                  resolve(point)
                },
              })
            })
          if (command === 'restore_project_backup')
            return ++restoreCount === 1
              ? Promise.reject('备份素材校验失败')
              : Promise.resolve({
                  ...saved,
                  id: 'restored-project',
                  name: '已编辑项目 · 恢复副本',
                })
          if (command.startsWith('list_')) return Promise.resolve([])
          if (command === 'get_media_budget')
            return Promise.resolve({ limitMicroUsd: null, reservedMicroUsd: 0 })
          return new Promise(() => {})
        },
      },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByText('项目备份与恢复', { exact: true }).click()
  const panel = page.getByRole('region', { name: '项目备份与恢复' })
  const create = panel.getByRole('button', {
    name: '备份当前项目',
    exact: true,
  })
  await expect(create).toBeDisabled()
  await panel.getByRole('button', { name: '选择备份位置' }).click()
  await expect(panel).toContainText('尚未选择备份位置')
  await panel.getByRole('button', { name: '选择备份位置' }).click()
  await expect(create).toBeEnabled()
  await page.getByLabel('工作流名称').fill('已编辑项目')
  await create.click()
  await expect(create).toBeDisabled()
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          globalThis as unknown as { backupFixtureCalls: string[] }
        ).backupFixtureCalls.includes('create_project_backup'),
      ),
    )
    .toBe(true)
  await page.evaluate(() =>
    (
      globalThis as unknown as { finishBackupFixture: () => void }
    ).finishBackupFixture(),
  )
  await expect(panel).toContainText('备份已完成：新增 4.0 KB，复用 4.0 KB。')
  await expect(panel.getByLabel('备份记录')).toContainText('已编辑项目')
  const calls = await page.evaluate(
    () =>
      (globalThis as unknown as { backupFixtureCalls: string[] })
        .backupFixtureCalls,
  )
  expect(calls[calls.indexOf('create_project_backup') - 1]).toBe(
    'save_workflow',
  )
  const restore = panel.getByRole('button', { name: '恢复为新项目' })
  await restore.click()
  await expect(panel.getByRole('alert')).toContainText('备份素材校验失败')
  await expect(page.getByLabel('工作流名称')).toHaveValue('已编辑项目')
  await restore.click()
  await expect(page.getByLabel('工作流名称')).toHaveValue(
    '已编辑项目 · 恢复副本',
  )
})
