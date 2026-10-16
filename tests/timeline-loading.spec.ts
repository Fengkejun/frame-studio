import { expect, test } from '@playwright/test'

test('timeline waits for its saved draft before exposing editing controls', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  // Browser-only IPC fixture. Native media behavior is covered by desktop-smoke.
  await page.addInitScript(() => {
    const draft = new Promise((resolve) => {
      Object.assign(globalThis, { releaseTimelineFixture: () => resolve(null) })
    })
    Object.assign(globalThis, {
      isTauri: true,
      __TAURI_INTERNALS__: {
        invoke: (command: string) => {
          if (command === 'get_default_workflow') return Promise.resolve(null)
          if (command === 'set_default_workflow') return Promise.resolve()
          if (command === 'get_app_info')
            return Promise.resolve({
              name: 'Frame Studio',
              version: '0.1.0',
              platform: 'fixture',
              architecture: 'fixture',
            })
          if (command === 'get_composition') return draft
          if (command.startsWith('list_')) return Promise.resolve([])
          if (command === 'get_media_budget')
            return Promise.resolve({ limitMicroUsd: null, reservedMicroUsd: 0 })
          if (command === 'save_workflow') return Promise.resolve()
          return new Promise(() => {})
        },
      },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByRole('button', { name: '时间线与导出', exact: true }).click()
  await expect(page.getByText('正在加载时间线…', { exact: true })).toBeVisible()
  await expect(page.getByLabel('背景音乐')).toHaveCount(0)
  await page.evaluate(() =>
    (
      globalThis as typeof globalThis & { releaseTimelineFixture: () => void }
    ).releaseTimelineFixture(),
  )
  await expect(page.getByLabel('背景音乐')).toBeVisible()
  await expect(page.getByText('正在加载时间线…', { exact: true })).toHaveCount(
    0,
  )
  expect(errors).toEqual([])
})
