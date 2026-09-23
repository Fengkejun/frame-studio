import { spawn, execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'

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
const app = spawn(executable, [], {
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: profile,
    FRAME_STUDIO_TEST_DATA_DIR: profile,
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
  expect(errors).toEqual([])
  console.log(
    'PASS: native Windows app, embedded assets, real Rust IPC, retry and persistent theme.',
  )
} finally {
  await browser?.close()
  if (app.pid && app.exitCode === null) {
    execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  }
}
