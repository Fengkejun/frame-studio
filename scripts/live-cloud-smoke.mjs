import path from 'node:path'
import { expect } from '@playwright/test'

// Opt-in, billable desktop run. Supply credentials through process environment.
export async function testLiveCloud(page, root) {
  const baseUrl = process.env.FRAME_STUDIO_LIVE_IMAGE_BASE_URL
  const apiKey = process.env.FRAME_STUDIO_LIVE_IMAGE_KEY
  if (!baseUrl && !apiKey) return
  if (!baseUrl || !apiKey) {
    throw new Error('Set both live image base URL and key for the opt-in test.')
  }

  await page.getByRole('button', { name: '云端生图' }).click()
  await page.getByLabel('云端图片 API 根地址').fill(baseUrl)
  await page.getByLabel('云端图片 API Key').fill(apiKey)
  await page.getByRole('button', { name: '保存密钥' }).click()
  try {
    await page.getByRole('button', { name: '检查连接' }).click()
    await expect(
      page.getByText(/密钥认证通过，当前模型出现在目录中/),
    ).toBeVisible({ timeout: 30000 })

    const jobs = page.locator('.image-job-history').first().locator('article')
    const previousJobs = await jobs.count()
    await page.getByRole('button', { name: '生成 1 张云端候选图' }).click()
    await expect(jobs).toHaveCount(previousJobs + 1, { timeout: 15000 })
    await expect(jobs.first().getByText('已完成', { exact: true })).toBeVisible(
      {
        timeout: 330000,
      },
    )
    await expect(
      page.locator('.asset-card').filter({ hasText: '云端候选' }),
    ).toHaveCount(3)
    await page.screenshot({
      path: path.join(root, 'artifacts/desktop-live-cloud-generation.png'),
      fullPage: true,
    })

    if (process.env.FRAME_STUDIO_LIVE_IMAGE_EDIT === '1') {
      const beforeEdit = await jobs.count()
      await page.getByLabel('云端生图方式').selectOption({ index: 1 })
      await page.getByRole('button', { name: '参考图生成 1 张候选图' }).click()
      await expect(jobs).toHaveCount(beforeEdit + 1, { timeout: 15000 })
      await expect(
        jobs.first().getByText('已完成', { exact: true }),
      ).toBeVisible({
        timeout: 330000,
      })
      await expect(
        page.locator('.asset-card').filter({ hasText: '云端候选' }),
      ).toHaveCount(4)
      await page.screenshot({
        path: path.join(root, 'artifacts/desktop-live-cloud-edit.png'),
        fullPage: true,
      })
    }
    console.log('PASS: live cloud catalog and desktop generation.')
  } finally {
    // The form may be disabled while a request is still in flight.
    await page
      .evaluate(async (url) => {
        const tauri = globalThis.__TAURI_INTERNALS__
        if (!tauri?.invoke) throw new Error('Tauri IPC is unavailable')
        await tauri.invoke('clear_cloud_image_key', {
          baseUrl: url,
        })
      }, baseUrl)
      .catch(() =>
        console.warn('Live test credential cleanup needs manual review.'),
      )
  }
}
