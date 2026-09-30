import { expect, test } from '@playwright/test'

test('canvas keeps measured nodes visible through data and selection updates', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  const nodes = page.locator('.react-flow__node')
  await expect(nodes).toHaveCount(3)
  for (let i = 0; i < 3; i++) {
    await nodes.nth(i).locator('.node-mark').click()
    await page.getByRole('textbox', { name: '节点名称' }).fill(`节点校对 ${i}`)
    await page.getByRole('button', { name: '适应画布' }).click()
    for (let n = 0; n < 3; n++)
      await expect(nodes.nth(n)).toHaveCSS('visibility', 'visible')
  }
})
