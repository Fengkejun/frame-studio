import { spawn, execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import net from 'node:net'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { testMedia } from './media-smoke.mjs'
import { createCloudFixture, testCloudMedia } from './cloud-media-smoke.mjs'
import { createVideoFixture, testVideoMedia } from './video-media-smoke.mjs'
import { testTimelineMedia } from './timeline-media-smoke.mjs'

// Exercise the built app and real IPC, using an isolated WebView2 profile.
if (process.platform !== 'win32') {
  throw new Error('This native smoke test requires Windows / WebView2.')
}
const root = fileURLToPath(new URL('../', import.meta.url))
const executable = path.join(root, 'src-tauri/target/debug/frame-studio.exe')
await access(executable).catch(() => {
  throw new Error('Build first: npm run tauri -- build --debug --no-bundle')
})
const artifacts = path.join(root, 'artifacts')
await mkdir(artifacts, { recursive: true })
const profile = await mkdtemp(path.join(artifacts, 'webview-test-'))
const port = await new Promise((resolve, reject) => {
  const server = net.createServer()
  server.on('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    server.close(() => resolve(address.port))
  })
})
const endpoint = `http://127.0.0.1:${port}`
const cloudFixture = await createCloudFixture(root)
const videoFixture = await createVideoFixture(root)
const installedModels = new Set(['fixture-model:latest'])
const textServer = createServer(async (request, response) => {
  if (request.url === '/api/pull' && request.method === 'POST') {
    let body = ''
    for await (const chunk of request) body += chunk
    const model = JSON.parse(body).model
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    response.write(JSON.stringify({ status: 'pulling manifest' }) + '\n')
    response.write(
      JSON.stringify({ status: 'downloading', completed: 50, total: 100 }) +
        '\n',
    )
    installedModels.add(model)
    response.end(JSON.stringify({ status: 'success' }) + '\n')
    return
  }
  if (request.url !== '/api/tags') {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(
    JSON.stringify({
      models: [...installedModels].map((name) => ({ name, size: 1024 })),
    }),
  )
})
await new Promise((resolve) => textServer.listen(0, '127.0.0.1', resolve))
const textAddress = textServer.address()
const textUrl = `http://127.0.0.1:${textAddress.port}`
const app = spawn(executable, [], {
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: profile,
    FRAME_STUDIO_TEST_DATA_DIR: profile,
    FRAME_STUDIO_TEST_OPENAI_IMAGE_URL: cloudFixture.url,
    FRAME_STUDIO_TEST_WAN_URL: videoFixture.url,
    FRAME_STUDIO_TEST_EXPORT_PATH: path.join(profile, 'finished.mp4'),
  },
})
let launchError
let stderr = ''
app.on('error', (error) => {
  launchError = error
})
app.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-6000)
})
let browser
try {
  const deadline = Date.now() + 30000
  let ready = false
  while (Date.now() < deadline) {
    if (launchError) throw launchError
    if (app.exitCode !== null)
      throw new Error(`Native app exited (${app.exitCode}): ${stderr}`)
    try {
      const response = await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(1000),
      })
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      /* WebView is still starting. */
    }
    await delay(300)
  }
  if (!ready)
    throw new Error(`WebView2 debug endpoint did not start: ${stderr}`)
  browser = await chromium.connectOverCDP(endpoint)
  await expect
    .poll(() => browser.contexts().flatMap((context) => context.pages()).length)
    .toBeGreaterThan(0)
  const page = browser.contexts().flatMap((context) => context.pages())[0]
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  await expect(page.getByRole('status')).toHaveText('桌面连接正常', {
    timeout: 15000,
  })
  await expect(
    page.getByRole('heading', { name: '开始制作前，检查创作工具' }),
  ).toBeVisible()
  await expect(
    page.locator('.setup-card').filter({ hasText: '本机 MP4 合成' }),
  ).toContainText('本机合成工具可用', { timeout: 15000 })
  await expect(page.locator('.details-list')).toContainText('windows / x86_64')
  await expect(page.locator('.details-list')).toContainText('0.1.0')
  await page.getByRole('button', { name: '重新检查连接' }).click()
  await expect(page.getByRole('status')).toHaveText('桌面连接正常')
  await page.screenshot({ path: path.join(artifacts, 'desktop-native.png') })
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('radio', { name: /浅色/ }).check()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.getByRole('status')).toHaveText('桌面连接正常')
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await expect(page.getByRole('heading', { name: '工作流画布' })).toBeVisible()
  await expect(page.getByRole('button', { name: '▶ 运行工作流' })).toBeEnabled()
  await page.getByRole('button', { name: '模型连接', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: /让每位 Agent/ }),
  ).toBeVisible()
  await testMedia(page, root)
  await testCloudMedia(page, cloudFixture)
  await testVideoMedia(page, root, videoFixture)
  await testTimelineMedia(page, root, profile)
  await page.getByRole('button', { name: '模型连接', exact: true }).click()
  await page.getByLabel('连接名称').fill('本地文本测试')
  await page.getByLabel('API 根地址').fill(`${textUrl}/api`)
  await page.getByRole('button', { name: '刷新已安装模型' }).click()
  await expect(
    page.getByRole('button', { name: /fixture-model:latest.*GB/ }),
  ).toBeVisible()
  await page.getByRole('button', { name: /fixture-model:latest.*GB/ }).click()
  await expect(page.getByLabel('模型 ID')).toHaveValue('fixture-model:latest')
  await page.getByLabel('模型 ID').fill('fixture-new:latest')
  await page.getByRole('button', { name: '下载当前模型 ID' }).click()
  await expect(
    page.getByText('模型下载完成。保存连接后即可在画布中使用。'),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: /fixture-new:latest.*GB/ }),
  ).toBeVisible()
  await page.getByLabel('模型 ID').fill('fixture-model')
  await page.getByRole('button', { name: '保存连接' }).click()
  await expect(page.getByText('连接已保存。', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  const textStep = page.locator('.setup-card').filter({ hasText: '故事与分镜' })
  await expect(textStep).toContainText('已保存 1 个文本连接')
  await textStep.getByRole('button', { name: '检测模型' }).click()
  await expect(textStep).toContainText('连接正常，已找到配置的模型', {
    timeout: 15000,
  })
  for (const file of ['studio.sqlite', 'studio.sqlite-wal']) {
    const bytes = await readFile(path.join(profile, file)).catch(() => null)
    if (bytes) expect(bytes.includes(Buffer.from('fixture-key'))).toBe(false)
    if (bytes)
      expect(bytes.includes(Buffer.from('fixture-wan-key'))).toBe(false)
  }
  expect(errors).toEqual([])
  console.log(
    'PASS: native Windows app, embedded assets, real Rust IPC, retry and persistent theme.',
  )
} finally {
  await browser?.close()
  await cloudFixture.close()
  await videoFixture.close()
  await new Promise((resolve) => textServer.close(resolve))
  if (app.pid && app.exitCode === null) {
    execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  }
}
