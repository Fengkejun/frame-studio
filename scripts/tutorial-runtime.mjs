import { spawn, execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect } from '@playwright/test'

export async function openTutorialApp(
  root,
  profile,
  dataDirectory,
  environment = {},
) {
  await mkdir(profile, { recursive: true })
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
  const env = {
    ...process.env,
    ...environment,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
    WEBVIEW2_USER_DATA_FOLDER: profile,
  }
  if (dataDirectory) env.FRAME_STUDIO_TEST_DATA_DIR = dataDirectory
  else delete env.FRAME_STUDIO_TEST_DATA_DIR
  const app = spawn(
    path.join(root, 'src-tauri/target/debug/frame-studio.exe'),
    [],
    {
      windowsHide: true,
      stdio: 'ignore',
      env,
    },
  )
  let browser
  const close = async () => {
    await browser?.close().catch(() => {})
    if (app.pid && app.exitCode === null)
      execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
  }
  try {
    const endpoint = `http://127.0.0.1:${port}`
    await expect
      .poll(
        async () => {
          try {
            return (
              await fetch(`${endpoint}/json/version`, {
                signal: AbortSignal.timeout(1000),
              })
            ).ok
          } catch {
            return false
          }
        },
        { timeout: 30000 },
      )
      .toBe(true)
    browser = await chromium.connectOverCDP(endpoint)
    await expect
      .poll(
        () => browser.contexts().flatMap((context) => context.pages()).length,
      )
      .toBeGreaterThan(0)
    const page = browser.contexts().flatMap((context) => context.pages())[0]
    await expect(page.getByRole('status')).toHaveText('桌面连接正常', {
      timeout: 15000,
    })
    const invoke = (command, args = {}) =>
      page.evaluate(
        ({ command, args }) =>
          globalThis.__TAURI_INTERNALS__.invoke(command, args),
        { command, args },
      )
    return { page, invoke, close }
  } catch (error) {
    await close()
    throw error
  }
}

export async function recordTutorialPage(page, outputPath) {
  const session = await page.context().newCDPSession(page)
  let latest = await page.screenshot({ type: 'jpeg', quality: 85 })
  session.on('Page.screencastFrame', ({ data, sessionId }) => {
    latest = Buffer.from(data, 'base64')
    void session.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })
  await session.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 85,
    maxWidth: 1600,
    maxHeight: 1000,
  })
  const encoder = spawn(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'image2pipe',
      '-framerate',
      '10',
      '-i',
      'pipe:0',
      '-vf',
      'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=0x111714',
      '-r',
      '30',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      outputPath,
    ],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] },
  )
  let stderr = ''
  let failure
  encoder.on('error', (error) => {
    failure = error
  })
  encoder.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4000)
  })
  encoder.stdin.on('error', (error) => {
    failure = error
  })
  const completion = new Promise((resolve) => encoder.on('close', resolve))
  const interval = setInterval(() => {
    if (!failure) encoder.stdin.write(latest)
  }, 100)
  return async () => {
    clearInterval(interval)
    await session.send('Page.stopScreencast').catch(() => {})
    await session.detach()
    encoder.stdin.end()
    const code = await completion
    if (failure || code !== 0)
      throw new Error(
        `Tutorial recording failed: ${failure?.message || stderr}`,
      )
  }
}

export const wait = (seconds) => delay(seconds * 1000)
