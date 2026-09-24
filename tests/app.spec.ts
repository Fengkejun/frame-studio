import { expect, test } from '@playwright/test'

test('first-run guide opens each media step without fabricating desktop checks', async ({
  page,
}) => {
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: '开始制作前，检查创作工具' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: '检测模型' })).toBeDisabled()
  await expect(
    page.getByRole('button', { name: '检测 ComfyUI' }),
  ).toBeDisabled()
  await expect(page.getByText('浏览器预览展示配置步骤')).toBeVisible()
  await page.screenshot({
    path: 'artifacts/onboarding-browser.png',
    fullPage: true,
  })
  await page.getByRole('button', { name: '收起引导' }).click()
  await expect(page.locator('.setup-card')).toHaveCount(0)
  await page.reload()
  await page.getByRole('button', { name: '展开引导' }).click()
  await expect(page.locator('.setup-card')).toHaveCount(4)
  await page.getByRole('button', { name: '打开首帧设置' }).click()
  await expect(
    page.getByRole('heading', { name: '让分镜成为画面' }),
  ).toBeVisible()
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await page.getByRole('button', { name: '配置视频服务' }).click()
  await expect(
    page.getByRole('heading', { name: '从首帧生成镜头片段' }),
  ).toBeVisible()
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await page.getByRole('button', { name: '打开时间线' }).click()
  await expect(page.getByRole('heading', { name: '成片合成' })).toBeVisible()
})

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
  await page.getByRole('button', { name: '图片节点' }).click()
  await expect(
    page.locator('.react-flow__node').filter({ hasText: '图片节点' }),
  ).toHaveCount(1)
  await expect(page.getByText('已确认首帧 0 / 0')).toBeVisible()
  await expect(
    page.getByRole('button', { name: '汇集已选首帧' }),
  ).toBeDisabled()
  await expect(page.getByText('已保存到本机')).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '工作流名称' })).toHaveValue(
    '雨夜书店分镜',
  )
  await expect(
    page.locator('.react-flow__node').filter({ hasText: '图片节点' }),
  ).toHaveCount(1)
  await expect(
    page.getByRole('button', { name: '▶ 运行工作流' }),
  ).toBeDisabled()
})

test('image studio keeps native-only operations disabled in browser preview', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByRole('button', { name: '首帧与素材', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '让分镜成为画面' }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: '＋ 导入图片' })).toBeDisabled()
  await expect(page.getByText('请先生成或录入分镜')).toBeAttached()
  await page.getByRole('button', { name: '本地素材库', exact: true }).click()
  await expect(page.getByText('你的本地图片素材库')).toBeVisible()
  await page.setViewportSize({ width: 960, height: 640 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true)
})
