import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'

// Fixed PNG and a fake API key: no external requests or image-model charges.
export async function createCloudFixture(root) {
  const png = await readFile(path.join(root, 'src-tauri/icons/128x128.png'))
  const requests = []
  let mode = 'success'
  let catalogMode = 'success'
  const catalogRequests = []
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      catalogRequests.push({ authorization: req.headers.authorization })
      res.setHeader('Content-Type', 'application/json')
      if (catalogMode === 'reject') {
        res.writeHead(401).end(JSON.stringify({ error: 'invalid_api_key' }))
      } else if (catalogMode === 'rate_limited') {
        res.writeHead(429).end(JSON.stringify({ error: 'rate_limit' }))
      } else {
        res.end(
          JSON.stringify({
            data: catalogMode === 'missing' ? [] : [{ id: 'gpt-image-2' }],
          }),
        )
      }
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const edit = req.url === '/v1/images/edits'
    if (
      !['/v1/images/generations', '/v1/images/edits'].includes(req.url) ||
      req.method !== 'POST'
    ) {
      res.writeHead(404).end()
      return
    }
    requests.push({
      authorization: req.headers.authorization,
      path: req.url,
      body: edit ? body.toString('latin1') : JSON.parse(body.toString()),
    })
    if (mode === 'lost') {
      req.socket.destroy()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (mode === 'reject') {
      res
        .writeHead(401)
        .end(JSON.stringify({ error: { message: 'fixture rejection' } }))
      return
    }
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/images/generations`,
    screenshotPath: path.join(root, 'artifacts/desktop-cloud-image-studio.png'),
    requests,
    catalogRequests,
    setCatalogMode: (next) => {
      catalogMode = next
    },
    setMode: (next) => {
      mode = next
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

export async function testCloudMedia(page, fixture) {
  await page.getByRole('button', { name: '首帧与素材', exact: true }).click()
  await page.getByRole('button', { name: '云端生图' }).click()
  await expect(page.getByLabel('云端生图提示词')).toHaveValue(
    'New storyboard version',
  )
  await page.getByLabel('OpenAI 图片 API Key').fill('fixture-key')
  await page.getByRole('button', { name: '保存密钥' }).click()
  await expect(page.getByText('密钥已保存在系统凭据库')).toBeVisible()
  await page.getByRole('button', { name: '检查连接' }).click()
  await expect(
    page.getByText(/密钥认证通过，当前模型出现在目录中/),
  ).toBeVisible()
  expect(fixture.catalogRequests).toEqual([
    { authorization: 'Bearer fixture-key' },
  ])
  expect(fixture.requests).toHaveLength(0)
  fixture.setCatalogMode('missing')
  await page.getByRole('button', { name: '检查连接' }).click()
  await expect(page.getByText(/当前模型未出现在目录中/)).toBeVisible()
  fixture.setCatalogMode('reject')
  await page.getByRole('button', { name: '检查连接' }).click()
  await expect(page.getByText(/认证或地区不匹配/)).toBeVisible()
  fixture.setCatalogMode('rate_limited')
  await page.getByRole('button', { name: '检查连接' }).click()
  await expect(page.getByText(/限流或配额错误/)).toBeVisible()
  expect(fixture.requests).toHaveLength(0)
  fixture.setCatalogMode('success')
  await page.getByRole('button', { name: '检查连接' }).click()
  await expect(
    page.getByText(/密钥认证通过，当前模型出现在目录中/),
  ).toBeVisible()
  await page.getByLabel('项目云端媒体预算上限').fill('0.10')
  await page.getByRole('button', { name: '保存预算' }).click()
  await expect(page.getByText(/已预留 \$0.00 \/ \$0.10/)).toBeVisible()
  await page.getByRole('button', { name: '生成 1 张云端候选图' }).click()
  await expect(page.getByText(/超过项目预算上限/)).toBeVisible()
  expect(fixture.requests).toHaveLength(0)
  await page.getByLabel('项目云端媒体预算上限').fill('10')
  await page.getByRole('button', { name: '保存预算' }).click()
  await page.getByRole('button', { name: '生成 1 张云端候选图' }).click()
  const jobs = page.locator('.image-job-history').first().locator('article')
  await expect(jobs.first().getByText('已完成', { exact: true })).toBeVisible({
    timeout: 20000,
  })
  expect(fixture.requests).toHaveLength(1)
  expect(fixture.requests[0].authorization).toBe('Bearer fixture-key')
  expect(fixture.requests[0].body).toMatchObject({
    model: 'gpt-image-2',
    n: 1,
    size: '1024x1536',
    quality: 'low',
    prompt: 'New storyboard version',
  })
  await page.getByRole('button', { name: '当前镜头', exact: true }).click()
  const candidate = page.locator('.asset-card').filter({ hasText: '云端候选' })
  await expect(candidate).toHaveCount(1)
  await candidate.getByRole('button', { name: '选为首帧' }).click()
  await page.getByRole('button', { name: '确认使用此版本' }).click()
  await expect(page.locator('.first-frame-target')).toContainText(
    '已选定镜头首帧',
  )
  await page.getByLabel('角色名称').fill('主角小猫')
  await candidate.getByRole('button', { name: '绑定为角色参考图' }).click()
  await expect(page.locator('.role-reference-list')).toContainText('主角小猫')
  await page.getByLabel('云端生图方式').selectOption({ index: 1 })
  await page.getByRole('button', { name: '参考图生成 1 张候选图' }).click()
  await expect(jobs).toHaveCount(2, { timeout: 20000 })
  await expect(jobs.first().getByText('已完成', { exact: true })).toBeVisible({
    timeout: 20000,
  })
  expect(fixture.requests).toHaveLength(2)
  expect(fixture.requests[1].path).toBe('/v1/images/edits')
  expect(fixture.requests[1].authorization).toBe('Bearer fixture-key')
  expect(fixture.requests[1].body).toContain('name="image[]"')
  expect(fixture.requests[1].body).toContain('name="prompt"')
  expect(fixture.requests[1].body).toContain('New storyboard version')
  expect(fixture.requests[1].body).toContain('PNG')
  await expect(page.locator('.first-frame-target')).toContainText(
    '已选定镜头首帧',
  )
  await expect(candidate).toHaveCount(2)
  await page.getByLabel('云端生图方式').selectOption('')
  await page.screenshot({ path: fixture.screenshotPath, fullPage: true })

  fixture.setMode('reject')
  await page.getByRole('button', { name: '生成 1 张云端候选图' }).click()
  await expect(jobs.first().getByText('失败', { exact: true })).toBeVisible({
    timeout: 20000,
  })
  fixture.setMode('lost')
  await page.getByRole('button', { name: '生成 1 张云端候选图' }).click()
  await expect(
    jobs.first().getByText('提交结果未知', { exact: true }),
  ).toBeVisible({
    timeout: 20000,
  })
  expect(fixture.requests).toHaveLength(4)
  await expect(page.getByText(/已预留 \$1.00 \/ \$10.00/)).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByRole('button', { name: '首帧与素材', exact: true }).click()
  await expect(page.locator('.first-frame-target')).toContainText(
    '已选定镜头首帧',
  )
  await expect(page.locator('.image-job-history').first()).toContainText(
    '结果未知',
  )
  await expect(page.locator('.role-reference-list')).toContainText('主角小猫')
  await page.getByRole('button', { name: '移除密钥' }).click()
  await expect(page.getByText('请先保存密钥。')).toBeVisible()
  console.log(
    'PASS: cloud image IPC, fake OpenAI protocol, keyring, image persistence, explicit selection, rejection and uncertain response. Fixture only; no external API call.',
  )
}
