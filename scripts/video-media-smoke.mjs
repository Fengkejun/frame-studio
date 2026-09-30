import http from 'node:http'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { expect } from '@playwright/test'

// Deterministic Wan protocol fixture. No external request or billable inference.
export async function createVideoFixture(root) {
  const mp4 = await readFile(path.join(root, 'tests/fixtures/clip.mp4'))
  const requests = []
  const catalogRequests = []
  const polls = new Map()
  let mode = 'success'
  let catalogMode = 'success'
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/api/v1/models') {
      catalogRequests.push({
        authorization: req.headers.authorization,
        model: url.searchParams.get('model'),
      })
      res.setHeader('Content-Type', 'application/json')
      if (catalogMode === 'reject') {
        res.writeHead(401).end(JSON.stringify({ code: 'InvalidApiKey' }))
      } else {
        res.end(
          JSON.stringify({
            success: true,
            output: {
              models:
                catalogMode === 'missing'
                  ? []
                  : [{ model: 'wan2.7-i2v-2026-04-25' }],
            },
          }),
        )
      }
    } else if (
      req.method === 'POST' &&
      url.pathname === '/api/v1/services/aigc/video-generation/video-synthesis'
    ) {
      let body = ''
      for await (const chunk of req) body += chunk
      const payload = JSON.parse(body)
      const id = `video-${requests.length + 1}`
      requests.push({
        payload,
        authorization: req.headers.authorization,
        asyncHeader: req.headers['x-dashscope-async'],
        id,
        mode,
      })
      if (mode === 'lost') {
        req.socket.destroy()
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({ output: { task_id: id, task_status: 'PENDING' } }),
      )
    } else if (
      req.method === 'GET' &&
      url.pathname.startsWith('/api/v1/tasks/')
    ) {
      const id = url.pathname.split('/').at(-1)
      const previous = polls.get(id) ?? 0
      polls.set(id, previous + 1)
      const submitted = requests.find((request) => request.id === id)
      const status =
        submitted?.mode === 'expired'
          ? 'UNKNOWN'
          : submitted?.mode === 'fail'
            ? 'FAILED'
            : mode === 'hold' || previous === 0
              ? 'RUNNING'
              : 'SUCCEEDED'
      res.setHeader('Content-Type', 'application/json')
      res.end(
        JSON.stringify({
          output: {
            task_id: id,
            task_status: status,
            video_url: `http://127.0.0.1:${server.address().port}/clip.mp4`,
            message: status === 'FAILED' ? 'fixture video failure' : '',
          },
        }),
      )
    } else if (req.method === 'GET' && url.pathname === '/clip.mp4') {
      res.setHeader('Content-Type', 'video/mp4')
      res.end(mp4)
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/api/v1/services/aigc/video-generation/video-synthesis`,
    requests,
    catalogRequests,
    polls,
    setMode: (value) => {
      mode = value
    },
    setCatalogMode: (value) => {
      catalogMode = value
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

export async function testVideoMedia(page, root, fixture) {
  await page.getByRole('button', { name: '首帧与素材', exact: true }).click()
  await page
    .locator('input[type=file][accept="image/png,image/jpeg,image/webp"]')
    .setInputFiles(path.join(root, 'src-tauri/icons/128x128@2x.png'))
  const largeImage = page
    .locator('.asset-card')
    .filter({ hasText: '128x128@2x.png' })
  await expect(largeImage).toBeVisible()
  await largeImage.getByRole('button', { name: '选为首帧' }).click()
  await page.getByRole('button', { name: '确认使用此版本' }).click()
  await page.getByRole('button', { name: '镜头视频', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: '从首帧生成镜头片段' }),
  ).toBeVisible()
  await expect(page.getByLabel('视频提示词')).toHaveValue(
    'Slow push in toward the cat',
  )
  await page.getByLabel('万相 API Key').fill('fixture-wan-key')
  await page.getByRole('button', { name: '保存密钥' }).click()
  await expect(page.getByText('当前地区密钥已保存在系统凭据库。')).toBeVisible()
  await page.getByRole('button', { name: '检查连接' }).click()
  await expect(
    page.getByText(/密钥认证通过，当前模型出现在目录中/),
  ).toBeVisible()
  expect(fixture.catalogRequests).toEqual([
    {
      authorization: 'Bearer fixture-wan-key',
      model: 'wan2.7-i2v-2026-04-25',
    },
  ])
  expect(fixture.requests).toHaveLength(0)
  fixture.setCatalogMode('missing')
  await page.getByRole('button', { name: '检查连接' }).click()
  await expect(page.getByText(/当前模型未出现在目录中/)).toBeVisible()
  fixture.setCatalogMode('reject')
  await page.getByRole('button', { name: '检查连接' }).click()
  await expect(page.getByText(/认证或地区不匹配/)).toBeVisible()
  expect(fixture.requests).toHaveLength(0)
  fixture.setCatalogMode('success')
  await page.getByRole('button', { name: '检查连接' }).click()
  await expect(
    page.getByText(/密钥认证通过，当前模型出现在目录中/),
  ).toBeVisible()
  await expect(page.getByText(/本次视频标价预估：\$0.50/)).toBeVisible()
  await page.getByLabel('项目云端媒体预算上限').fill('1.20')
  await page.getByRole('button', { name: '保存预算' }).click()
  await page.getByRole('button', { name: '提交图生视频任务' }).click()
  await expect(page.getByText(/超过项目预算上限/)).toBeVisible()
  expect(fixture.requests).toHaveLength(0)
  await page.getByLabel('项目云端媒体预算上限').fill('10')
  await page.getByRole('button', { name: '保存预算' }).click()
  await page.getByRole('button', { name: '提交图生视频任务' }).click()
  const jobs = page.locator('.video-studio .image-job-history article')
  await expect(jobs).toHaveCount(1)
  await expect(jobs.first().getByText('已保存', { exact: true })).toBeVisible({
    timeout: 20000,
  })
  expect(fixture.requests).toHaveLength(1)
  const submitted = fixture.requests[0]
  expect(submitted.authorization).toBe('Bearer fixture-wan-key')
  expect(submitted.asyncHeader).toBe('enable')
  expect(submitted.payload).toMatchObject({
    model: 'wan2.7-i2v-2026-04-25',
    input: {
      prompt: 'Slow push in toward the cat',
      media: [{ type: 'first_frame' }],
    },
    parameters: { duration: 5, resolution: '720P', prompt_extend: false },
  })
  expect(submitted.payload.input.media[0].url).toMatch(
    /^data:image\/jpeg;base64,/,
  )
  const cards = page.locator('.video-candidates .asset-card')
  await expect(cards).toHaveCount(1)
  await cards.first().getByRole('button', { name: '播放片段' }).click()
  await expect(page.getByLabel('镜头视频预览')).toHaveAttribute(
    'src',
    /^data:video\/mp4;base64,/,
  )
  const video = page.getByLabel('镜头视频预览')
  await expect
    .poll(() => video.evaluate((element) => element.readyState))
    .toBeGreaterThanOrEqual(2)
  expect(await video.evaluate((element) => element.videoWidth)).toBe(256)
  await video.evaluate(async (element) => {
    element.muted = true
    await element.play()
  })
  await expect
    .poll(() => video.evaluate((element) => element.currentTime))
    .toBeGreaterThan(0)
  await page
    .locator('.video-studio')
    .screenshot({ path: path.join(root, 'artifacts/video-studio.png') })
  await page.getByRole('button', { name: '关闭预览' }).click()

  // The video node records explicit selections, not automatic generation.
  await page.getByTestId('rf__node-image-fixture').locator('.node-mark').click()
  await page.getByRole('button', { name: '汇集已选首帧' }).click()
  await page.getByRole('button', { name: '开始执行' }).click()
  await expect(page.locator('.node-inspector .output-preview')).toContainText(
    '1 个首帧版本',
  )
  await page.getByRole('button', { name: '适应画布' }).click()
  await page.getByTestId('rf__node-video-fixture').locator('.node-mark').click()
  await page.getByRole('button', { name: '汇集已选片段' }).click()
  await page.getByRole('button', { name: '开始执行' }).click()
  await expect(page.locator('.run-history > details').first()).toContainText(
    '等待片段',
  )
  await page.getByRole('button', { name: '镜头视频', exact: true }).click()
  await cards.first().getByRole('button', { name: '选为镜头片段' }).click()
  await expect(page.locator('.video-candidates')).toContainText('已选片段版本')
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByTestId('rf__node-video-fixture').locator('.node-mark').click()
  await page.getByRole('button', { name: '汇集已选片段' }).click()
  await page.getByRole('button', { name: '开始执行' }).click()
  await expect(page.locator('.node-inspector .output-preview')).toContainText(
    '1 个视频片段版本',
  )
  await page.getByRole('button', { name: '镜头视频', exact: true }).click()

  // A failed rerun leaves the selected old clip untouched.
  fixture.setMode('fail')
  await page.getByRole('button', { name: '提交图生视频任务' }).click()
  await expect(jobs).toHaveCount(2)
  await expect(jobs.first().getByText('失败', { exact: true })).toBeVisible({
    timeout: 20000,
  })
  await expect(page.locator('.video-candidates')).toContainText('已选片段版本')

  // Pause and resume query of the same remote task after WebView reload.
  fixture.setMode('hold')
  await page.getByRole('button', { name: '提交图生视频任务' }).click()
  await expect(jobs).toHaveCount(3)
  await expect(jobs.first().getByText('生成中', { exact: true })).toBeVisible({
    timeout: 20000,
  })
  await jobs.first().getByRole('button', { name: '停止本地查询' }).click()
  await expect(
    jobs.first().getByText('待继续查询', { exact: true }),
  ).toBeVisible({ timeout: 20000 })
  await page.reload()
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByRole('button', { name: '镜头视频', exact: true }).click()
  await expect(
    jobs.first().getByText('待继续查询', { exact: true }),
  ).toBeVisible()
  fixture.setMode('success')
  await jobs.first().getByRole('button', { name: '继续查询原任务' }).click()
  await expect(jobs.first().getByText('已保存', { exact: true })).toBeVisible({
    timeout: 20000,
  })
  expect(fixture.requests).toHaveLength(3)
  await expect(cards).toHaveCount(2)
  await expect(page.locator('.video-candidates')).toContainText('已选片段版本')
  fixture.setMode('expired')
  await page.getByRole('button', { name: '提交图生视频任务' }).click()
  await expect(jobs).toHaveCount(4)
  await expect(jobs.first().getByText('结果未知', { exact: true })).toBeVisible(
    { timeout: 20000 },
  )
  await expect(
    jobs.first().getByRole('button', { name: '继续查询原任务' }),
  ).toHaveCount(0)
  fixture.setMode('lost')
  await page.getByRole('button', { name: '提交图生视频任务' }).click()
  await expect(jobs).toHaveCount(5)
  await expect(jobs.first().getByText('结果未知', { exact: true })).toBeVisible(
    { timeout: 20000 },
  )
  expect(fixture.requests).toHaveLength(5)
  await expect(cards).toHaveCount(2)
  await page.getByRole('button', { name: '移除密钥' }).click()
  console.log(
    'PASS: Wan video submit, task ID polling, MP4 persistence/playback, clip selection, failed rerun isolation, pause/resume without resubmission, expired tasks and lost submission responses. Fixture only.',
  )
}
