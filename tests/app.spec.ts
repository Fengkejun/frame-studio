import { expect, test } from '@playwright/test'

test('browser preview opens the editable workflow canvas without fabricating native execution', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    '从一个想法',
  )
  await expect(page.getByRole('status')).toHaveText('浏览器预览')
  await expect(
    page.getByRole('button', { name: '重新检查连接' }),
  ).toBeDisabled()
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await expect(page.getByRole('heading', { name: '工作流画布' })).toBeVisible()
  await expect(
    page.getByRole('button', { name: '▶ 运行工作流' }),
  ).toBeDisabled()
  await expect(page.getByRole('heading', { name: '故事编剧' })).toBeVisible()
  await page.getByRole('button', { name: '提示词助手' }).click()
  await expect(page.getByRole('heading', { name: '工作流画布' })).toBeVisible()
  await page.screenshot({
    path: 'artifacts/workspace-dark.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 960, height: 640 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
  expect(errors).toEqual([])
})

test('theme selection survives a reload and system preference updates live', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('radio', { name: /浅色/ }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('radio', { name: /浅色/ })).toBeChecked()
  await page.screenshot({
    path: 'artifacts/settings-light.png',
    fullPage: true,
  })
  await page.getByRole('radio', { name: /跟随系统/ }).check()
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('unavailable preference storage does not crash the app', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException('Storage blocked', 'SecurityError')
    }
    Storage.prototype.setItem = () => {
      throw new DOMException('Storage blocked', 'SecurityError')
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('radio', { name: /浅色/ }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.getByRole('alert')).toContainText('无法保存偏好')
})

test('browser canvas persists graph edits and rejects native execution honestly', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByRole('textbox', { name: '工作流名称' }).fill('雨夜书店分镜')
  await page.getByRole('button', { name: '提示词助手' }).click()
  await expect(page.getByRole('heading', { name: '提示词助手' })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '工作流名称' })).toHaveValue(
    '雨夜书店分镜',
  )
  await expect(
    page.getByRole('button', { name: '▶ 运行工作流' }),
  ).toBeDisabled()
})
