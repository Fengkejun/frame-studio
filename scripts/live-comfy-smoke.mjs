import path from 'node:path'
import { expect } from '@playwright/test'

// Opt-in check against a running local ComfyUI. EmptyImage exercises the real
// queue/history/view protocol without requiring a checkpoint or model download.
export async function testLiveComfy(page, root) {
  const baseUrl = process.env.FRAME_STUDIO_LIVE_COMFY_URL
  if (!baseUrl) return

  await page.getByRole('button', { name: '本机 ComfyUI' }).click()
  await page.getByLabel('ComfyUI 地址').fill(baseUrl)
  await page.getByLabel('ComfyUI 工作流模式').selectOption('custom')
  const graph = {
    11: {
      class_type: 'EmptyImage',
      inputs: {
        width: '{{width}}',
        height: '{{height}}',
        batch_size: '{{count}}',
        color: 16711680,
      },
    },
    20: {
      class_type: 'SaveImage',
      inputs: { images: ['11', 0], filename_prefix: '{{output_prefix}}' },
    },
  }
  await page.getByLabel('导入 ComfyUI API 工作流 JSON').setInputFiles({
    name: 'empty-image-api.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(graph)),
  })
  await page.getByLabel('ComfyUI 角色参考图').selectOption('')
  await page.getByRole('spinbutton', { name: '宽度' }).fill('256')
  await page.getByRole('spinbutton', { name: '高度' }).fill('256')
  await page.getByRole('spinbutton', { name: '候选数量' }).fill('1')
  const jobs = page.locator('.image-job-history').last().locator('article')
  const before = await jobs.count()
  await page.getByRole('button', { name: '生成 1 张候选图' }).click()
  await expect(jobs).toHaveCount(before + 1, { timeout: 15000 })
  await expect(jobs.first().getByText('已完成', { exact: true })).toBeVisible({
    timeout: 90000,
  })
  await expect(page.locator('.asset-card')).toHaveCount(9)
  const referenceGraph = {
    12: {
      class_type: 'LoadImage',
      inputs: { image: '{{reference_image}}' },
    },
    21: {
      class_type: 'SaveImage',
      inputs: { images: ['12', 0], filename_prefix: '{{output_prefix}}' },
    },
  }
  await page.getByLabel('导入 ComfyUI API 工作流 JSON').setInputFiles({
    name: 'reference-api.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(referenceGraph)),
  })
  await page.getByLabel('ComfyUI 角色参考图').selectOption({ index: 1 })
  await page.getByRole('button', { name: '生成 1 张候选图' }).click()
  await expect(jobs).toHaveCount(before + 2, { timeout: 15000 })
  await expect(jobs.first().getByText('已完成', { exact: true })).toBeVisible({
    timeout: 90000,
  })
  await expect(page.locator('.asset-card')).toHaveCount(10)
  await page
    .getByLabel('ComfyUI 工作流模式')
    .evaluate((element) =>
      element.scrollIntoView({ block: 'start', behavior: 'instant' }),
    )
  await page.screenshot({
    path: path.join(root, 'artifacts/desktop-live-comfyui.png'),
    fullPage: true,
  })
  console.log(
    'PASS: real local ComfyUI custom EmptyImage and uploaded-reference workflows through desktop IPC, history, view and asset storage. No AI model used.',
  )
}
