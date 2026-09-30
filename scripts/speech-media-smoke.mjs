import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'

export async function createSpeechFixture(root) {
  const wav = await readFile(path.join(root, 'tests/fixtures/voice.wav'))
  const requests = []
  let mode = 'success'
  const server = http.createServer(async (request, response) => {
    if (request.url === '/v1/models' && request.method === 'GET') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini-tts' }] }))
      return
    }
    if (request.url !== '/v1/audio/speech' || request.method !== 'POST') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    })
    if (mode === 'lost') {
      request.socket.destroy()
      return
    }
    if (mode === 'reject') {
      response.writeHead(401).end()
      return
    }
    if (mode === 'invalid') {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
      return
    }
    if (mode === 'oversized') {
      response
        .writeHead(200, { 'Content-Length': 21 * 1024 * 1024 })
        .end('too large')
      return
    }
    response.writeHead(200, { 'Content-Type': 'audio/wav' }).end(wav)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    setMode: (value) => {
      mode = value
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

export async function testSpeechMedia(page, fixture, root) {
  const studio = page.locator('.voiceover-studio')
  await studio.locator('.speech-connection summary').click()
  await page.getByLabel('语音 API 根地址').fill(fixture.baseUrl)
  await page.getByLabel('配音 API Key').fill('fixture-speech-key')
  await page.getByRole('button', { name: '保存配音密钥' }).click()
  await expect(studio).toContainText('密钥已保存到系统凭据库')
  await page.getByRole('button', { name: '检查语音服务' }).click()
  await expect(studio).toContainText('当前模型出现在目录中')
  expect(fixture.requests).toHaveLength(0)
  await page.getByRole('button', { name: '使用时间线字幕' }).click()
  await expect(page.getByLabel('旁白文本')).toHaveValue(
    'Hello from Frame Studio',
  )
  await page.getByLabel('旁白文本').fill('你好，这是自动验证的配音旁白。')
  await page.getByLabel('配音语速').fill('1.1')
  const originalVoice = await page
    .getByLabel('配音', { exact: true })
    .inputValue()
  await page.getByRole('button', { name: '生成配音', exact: true }).click()
  const success = studio.locator('.speech-job').first()
  await expect(success).toContainText('配音已完成', { timeout: 15000 })
  expect(fixture.requests).toEqual([
    {
      authorization: 'Bearer fixture-speech-key',
      body: {
        model: 'gpt-4o-mini-tts',
        input: '你好，这是自动验证的配音旁白。',
        voice: 'coral',
        speed: 1.1,
        response_format: 'wav',
      },
    },
  ])
  await expect(page.getByLabel('配音', { exact: true })).toHaveValue(
    originalVoice,
  )
  await success.getByRole('button', { name: '试听音频' }).click()
  await expect
    .poll(() => success.locator('audio').evaluate((audio) => audio.readyState))
    .toBeGreaterThan(0)
  await expect
    .poll(() => success.locator('audio').evaluate((audio) => audio.duration))
    .toBeGreaterThan(0)
  await success.getByRole('button', { name: '用作配音', exact: true }).click()
  const selected = await page.getByLabel('配音', { exact: true }).inputValue()
  expect(selected).not.toBe(originalVoice)
  await expect(
    success.getByRole('button', { name: '已用作配音' }),
  ).toBeDisabled()
  for (const [mode, message] of [
    ['reject', '配音失败'],
    ['invalid', '结果待核实'],
    ['oversized', '结果待核实'],
    ['lost', '结果待核实'],
  ]) {
    fixture.setMode(mode)
    const count = fixture.requests.length
    await page.getByRole('button', { name: '生成配音', exact: true }).click()
    await expect(studio.locator('.speech-job')).toHaveCount(count + 1)
    await expect(studio.locator('.speech-job').first()).toContainText(message, {
      timeout: 15000,
    })
    await expect(page.getByLabel('配音', { exact: true })).toHaveValue(selected)
  }
  expect(fixture.requests).toHaveLength(5)
  await studio.getByLabel('项目云端媒体预算上限').fill('0')
  await studio.getByRole('button', { name: '保存预算' }).click()
  await expect(studio.locator('.media-budget-panel')).toContainText('/ $0.00')
  await page.getByRole('button', { name: '生成配音', exact: true }).click()
  await expect(studio.getByRole('alert')).toContainText('超过项目预算上限')
  expect(fixture.requests).toHaveLength(5)
  await studio.getByLabel('项目云端媒体预算上限').fill('')
  await studio.getByRole('button', { name: '保存预算' }).click()
  await expect(studio.locator('.media-budget-panel')).toContainText(
    '未设置上限',
  )
  const isolation = await page.evaluate(
    async (baseUrl) =>
      globalThis.__TAURI_INTERNALS__.invoke('speech_key_status', {
        baseUrl: baseUrl.replace('127.0.0.1', 'localhost'),
      }),
    fixture.baseUrl,
  )
  expect(isolation).toBe(false)
  const stored = await page.evaluate(() => JSON.stringify(localStorage))
  expect(stored).not.toContain('fixture-speech-key')
  await page.getByRole('button', { name: '删除配音密钥' }).click()
  await expect(
    page.getByRole('button', { name: '生成配音', exact: true }),
  ).toBeDisabled()
  await page.screenshot({
    path: path.join(root, 'artifacts/desktop-voiceover-studio.png'),
  })
  fixture.setMode('success')
  console.log(
    'PASS: speech protocol and auth, WAV preview, explicit version selection, rejected/invalid/oversized/lost results, budget guard, credential isolation. Local fixture only.',
  )
}
