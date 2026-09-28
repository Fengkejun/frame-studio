import { spawn, execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'
import { testLiveWorkflow } from './live-workflow-smoke.mjs'

if (process.platform !== 'win32') {
  throw new Error('The live native workflow check requires Windows / WebView2.')
}
if (process.env.FRAME_STUDIO_LIVE_WORKFLOW !== '1') {
  throw new Error('Set FRAME_STUDIO_LIVE_WORKFLOW=1 to opt in.')
}
const root = fileURLToPath(new URL('../', import.meta.url))
const executable = path.join(root, 'src-tauri/target/debug/frame-studio.exe')
await access(executable)
const artifacts = path.join(root, 'artifacts')
await mkdir(artifacts, { recursive: true })
const profile = await mkdtemp(path.join(artifacts, 'live-workflow-'))
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
    if (app.exitCode !== null) throw new Error(`App exited (${app.exitCode})`)
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
  if (!ready) throw new Error('WebView2 debug endpoint did not start')
  browser = await chromium.connectOverCDP(endpoint)
  await expect
    .poll(() => browser.contexts().flatMap((context) => context.pages()).length)
    .toBeGreaterThan(0)
  const page = browser.contexts().flatMap((context) => context.pages())[0]
  await expect(page.getByRole('status')).toHaveText('桌面连接正常', {
    timeout: 15000,
  })
  await testLiveWorkflow(page)
} catch (error) {
  console.error(
    `Native app exit=${app.exitCode}; stderr=${stderr || '(empty)'}`,
  )
  throw error
} finally {
  await browser?.close().catch(() => {})
  if (app.pid && app.exitCode === null) {
    execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  }
}
