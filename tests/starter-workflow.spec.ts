import { expect, test } from '@playwright/test'
import {
  graphError,
  makeStarterWorkflow,
  parseWorkflow,
} from '../src/features/workflow/model'

test('starter has a complete valid pipeline with no unconnected input nodes', () => {
  const workflow = makeStarterWorkflow('configured-text')
  expect(graphError(workflow)).toBeNull()
  expect(parseWorkflow(JSON.stringify(workflow))).toEqual(workflow)
  expect(workflow.nodes).toHaveLength(7)
  expect(workflow.edges).toHaveLength(6)
  for (const node of workflow.nodes.filter((node) => node.kind !== 'brief'))
    expect(
      workflow.edges.filter((edge) => edge.target === node.id),
    ).toHaveLength(1)
  for (const node of workflow.nodes.filter((node) =>
    ['story', 'storyboard', 'prompt'].includes(node.kind),
  ))
    expect(node.config.providerId).toBe('configured-text')
})

test('default selection survives a newer project and reload without replacing existing work', async ({
  page,
}) => {
  await page.goto('/')
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await expect(page.getByLabel('工作流名称')).toHaveValue('默认 · AI 动漫短片')
  await expect(
    page.getByRole('button', { name: '✓ 默认工作流', exact: true }),
  ).toBeDisabled()
  await page.getByRole('button', { name: '＋ 新建工作流', exact: true }).click()
  await page.getByLabel('工作流名称').fill('保留我的旧项目')
  await expect(page.locator('.save-state')).toContainText('已保存')
  await page.reload()
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await expect(page.getByLabel('工作流名称')).toHaveValue('默认 · AI 动漫短片')
  await page.getByLabel('切换工作流').selectOption({ label: '保留我的旧项目' })
  await page
    .getByRole('button', { name: '设为默认工作流', exact: true })
    .click()
  await expect(
    page.getByRole('button', { name: '✓ 默认工作流', exact: true }),
  ).toBeDisabled()
  await page.reload()
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await expect(page.getByLabel('工作流名称')).toHaveValue('保留我的旧项目')
  await expect(page.getByLabel('切换工作流').locator('option')).toHaveCount(2)
})
