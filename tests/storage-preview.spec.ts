import { expect, test } from '@playwright/test'

test('browser settings keeps device storage operations unavailable', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const panel = page.getByRole('region', { name: '素材与存储', exact: true })
  await expect(
    panel.getByText('请在桌面应用中查看与清理本机素材。'),
  ).toBeVisible()
  await expect(
    panel.getByRole('button', { name: '刷新占用统计' }),
  ).toBeDisabled()
  await expect(panel.getByRole('button', { name: '确认永久删除' })).toHaveCount(
    0,
  )
})
