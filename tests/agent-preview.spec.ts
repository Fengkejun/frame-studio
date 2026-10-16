import { expect, test } from '@playwright/test'
test('Agent has a conversation entry and keeps real tool execution native-only', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '灵感创作', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '告诉我，你想讲一个怎样的故事？' }),
  ).toBeVisible()
  await page.getByRole('button', { name: /治愈动漫短片/ }).click()
  await expect(page.getByLabel('告诉 Agent 你的创作需求')).toHaveValue(/12秒/)
  await expect(
    page.getByRole('button', { name: '开始自动制作 ↑', exact: true }),
  ).toBeDisabled()
  await page.getByRole('button', { name: '模型设置', exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: 'Agent 模型设置' }),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '保存 Agent 配置' }),
  ).toBeDisabled()
  await page.getByRole('button', { name: '关闭模型设置' }).click()
  await page.getByRole('button', { name: '技能库', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '搜索网络技能', exact: true }),
  ).toBeDisabled()
  await page.getByRole('button', { name: '关闭技能库' }).click()
  await page.getByRole('button', { name: '模型连接', exact: true }).click()
  await page.getByRole('button', { name: '灵感创作', exact: true }).click()
  await expect(page.getByLabel('告诉 Agent 你的创作需求')).toHaveValue(/12秒/)
})
