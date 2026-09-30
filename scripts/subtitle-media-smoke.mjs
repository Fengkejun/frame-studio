import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'

export async function createTranscriptionFixture(root) {
  const wav = await readFile(path.join(root, 'tests/fixtures/voice.wav'))
  const requests = []
  let mode = 'success'
  const server = http.createServer(async (request, response) => {
    if (request.url === '/v1/models' && request.method === 'GET') {
      response
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ data: [{ id: 'whisper-1' }] }))
      return
    }
    if (
      request.url !== '/v1/audio/transcriptions' ||
      request.method !== 'POST'
    ) {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    requests.push({
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'],
      body,
    })
    if (mode === 'lost') {
      request.socket.destroy()
      return
    }
    if (mode === 'reject') {
      response.writeHead(401).end()
      return
    }
    if (mode === 'oversized') {
      response
        .writeHead(200, { 'Content-Length': 3 * 1024 * 1024 })
        .end('large')
      return
    }
    const segments =
      mode === 'out-of-range'
        ? [{ start: 0, end: 9999, text: 'invalid' }]
        : [{ start: 0.05, end: 0.65, text: 'Hello from transcription' }]
    response
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(
        JSON.stringify(
          mode === 'missing' ? { text: 'No timestamps' } : { segments },
        ),
      )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    wav,
    setMode: (value) => {
      mode = value
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

export async function testSubtitleMedia(page, fixture, root) {
  const studio = page.locator('.subtitle-studio')
  await studio.locator('.transcription-connection summary').click()
  await studio.getByLabel('转写 API 根地址').fill(fixture.baseUrl)
  await studio.getByLabel('转写 API Key').fill('fixture-transcription-key')
  await studio.getByRole('button', { name: '保存转写密钥' }).click()
  await expect(studio).toContainText('密钥已保存到系统凭据库')
  await studio.getByLabel('转写模型 ID').fill('fixture-transcriber')
  await expect(
    studio.getByRole('button', { name: '发送当前配音并生成字幕' }),
  ).toBeEnabled()
  await studio.getByLabel('转写模型 ID').fill('whisper-1')
  await studio.getByRole('button', { name: '检查转写服务' }).click()
  await expect(studio).toContainText('当前模型出现在目录中')
  expect(fixture.requests).toHaveLength(0)
  const voiceId = await page.getByLabel('配音', { exact: true }).inputValue()
  await studio.getByRole('button', { name: '发送当前配音并生成字幕' }).click()
  await expect(studio.locator('.transcription-job').first()).toContainText(
    '字幕识别完成',
    { timeout: 15000 },
  )
  expect(fixture.requests).toHaveLength(1)
  const upload = fixture.requests[0]
  expect(upload.authorization).toBe('Bearer fixture-transcription-key')
  expect(upload.contentType).toMatch(/^multipart\/form-data; boundary=/)
  const multipart = upload.body.toString('latin1')
  for (const [field, value] of [
    ['model', 'whisper-1'],
    ['response_format', 'verbose_json'],
    ['timestamp_granularities[]', 'segment'],
  ])
    expect(multipart).toContain(`name="${field}"\r\n\r\n${value}`)
  expect(multipart).toContain(`filename="${voiceId}.wav"`)
  expect(upload.body.includes(fixture.wav)).toBe(true)
  // Read the actual persisted workflow ID from the generated job, independent of UI local storage.
  const workflowId = await page.evaluate(async () => {
    const workflows =
      await globalThis.__TAURI_INTERNALS__.invoke('list_workflows')
    return workflows.find((w) =>
      w.nodes.some((n) => n.id === 'timeline-fixture'),
    ).id
  })
  const originalDraft = await page.evaluate(
    (id) =>
      globalThis.__TAURI_INTERNALS__.invoke('get_composition', {
        workflowId: id,
      }),
    workflowId,
  )
  expect(originalDraft.subtitleVersionId).toBeNull()
  await studio.locator('.transcription-history summary').click()
  await studio
    .getByRole('button', { name: '校对字幕', exact: true })
    .first()
    .click()
  const originalId = await studio.getByLabel('字幕版本预览').inputValue()
  await expect(studio.getByLabel('字幕 1 文本')).toHaveValue(
    'Hello from transcription',
  )
  await studio.getByLabel('字幕 1 结束').fill('0.01')
  await expect(
    studio.getByRole('button', { name: '保存字幕新版本' }),
  ).toBeDisabled()
  await studio.getByLabel('字幕 1 结束').fill('0.65')
  await studio.getByLabel('字幕 1 文本').fill('Hello corrected captions')
  await expect(
    studio.getByRole('button', { name: '应用字幕到时间线' }),
  ).toBeDisabled()
  await studio.getByRole('button', { name: '保存字幕新版本' }).click()
  await expect(
    studio.getByRole('button', { name: '应用字幕到时间线' }),
  ).toBeEnabled()
  const editedId = await studio.getByLabel('字幕版本预览').inputValue()
  expect(editedId).not.toBe(originalId)
  const assets = await page.evaluate(
    (id) =>
      globalThis.__TAURI_INTERNALS__.invoke('list_subtitle_assets', {
        workflowId: id,
      }),
    workflowId,
  )
  expect(assets).toHaveLength(2)
  expect(assets.find((a) => a.versionId === originalId).cues[0].text).toBe(
    'Hello from transcription',
  )
  expect(assets.find((a) => a.versionId === editedId).parentVersionId).toBe(
    originalId,
  )
  await studio.getByRole('button', { name: '应用字幕到时间线' }).click()
  await expect(
    page.getByText(`已应用自动字幕版本 ${editedId.slice(0, 8)}`),
  ).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          globalThis.__TAURI_INTERNALS__.invoke('get_composition', {
            workflowId: id,
          }),
        workflowId,
      ),
    )
    .toMatchObject({ subtitleVersionId: editedId })
  const draft = await page.evaluate(
    (id) =>
      globalThis.__TAURI_INTERNALS__.invoke('get_composition', {
        workflowId: id,
      }),
    workflowId,
  )
  expect(draft.subtitleText).toBe(
    '1\n00:00:00,050 --> 00:00:00,650\nHello corrected captions\n\n',
  )
  const srt = await page.evaluate(
    (id) =>
      globalThis.__TAURI_INTERNALS__.invoke('get_subtitle_srt', {
        versionId: id,
      }),
    editedId,
  )
  expect(srt).toBe(draft.subtitleText)
  await page.getByLabel('配音', { exact: true }).selectOption('')
  await expect(
    page.getByText(
      '已应用字幕与当前配音不匹配；请应用匹配的字幕，或改用片段字幕后再导出。',
    ),
  ).toBeVisible()
  await expect(
    page.getByRole('button', { name: '选择位置并导出 MP4' }),
  ).toBeDisabled()
  const tampered = await page.evaluate(
    async ({ draft, outputPath }) => {
      try {
        await globalThis.__TAURI_INTERNALS__.invoke('start_export', {
          draft: { ...draft, subtitleText: 'tampered' },
          outputPath,
        })
        return ''
      } catch (error) {
        return String(error)
      }
    },
    { draft, outputPath: path.join(root, 'artifacts/subtitles-guard.mp4') },
  )
  expect(tampered).toContain('字幕与当前配音或字幕文本不匹配')
  await page.getByLabel('配音', { exact: true }).selectOption(voiceId)
  for (const [mode, message] of [
    ['reject', '字幕识别失败'],
    ['missing', '结果待核实'],
    ['out-of-range', '结果待核实'],
    ['oversized', '结果待核实'],
    ['lost', '结果待核实'],
  ]) {
    fixture.setMode(mode)
    const count = fixture.requests.length
    await studio.getByRole('button', { name: '发送当前配音并生成字幕' }).click()
    await expect(studio.locator('.transcription-job')).toHaveCount(count + 1)
    await expect(studio.locator('.transcription-job').first()).toContainText(
      message,
      { timeout: 15000 },
    )
  }
  expect(fixture.requests).toHaveLength(6)
  await studio.getByLabel('项目云端媒体预算上限').fill('0')
  await studio.getByRole('button', { name: '保存预算' }).click()
  await expect(studio.locator('.media-budget-panel')).toContainText('/ $0.00')
  await studio.getByRole('button', { name: '发送当前配音并生成字幕' }).click()
  await expect(studio.getByRole('alert')).toContainText('超过项目预算上限')
  expect(fixture.requests).toHaveLength(6)
  await studio.getByLabel('项目云端媒体预算上限').fill('')
  await studio.getByRole('button', { name: '保存预算' }).click()
  await expect(studio.locator('.media-budget-panel')).toContainText(
    '未设置上限',
  )
  const isolated = await page.evaluate(
    (baseUrl) =>
      globalThis.__TAURI_INTERNALS__.invoke('transcription_key_status', {
        baseUrl: baseUrl.replace('127.0.0.1', 'localhost'),
      }),
    fixture.baseUrl,
  )
  expect(isolated).toBe(false)
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    'fixture-transcription-key',
  )
  await studio.getByRole('button', { name: '删除转写密钥' }).click()
  await expect(
    studio.getByRole('button', { name: '发送当前配音并生成字幕' }),
  ).toBeDisabled()
  await studio.locator('.subtitle-editor').scrollIntoViewIfNeeded()
  await page.setViewportSize({ width: 960, height: 640 })
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true)
  await page.setViewportSize({ width: 1360, height: 900 })
  await studio.locator('.subtitle-editor').scrollIntoViewIfNeeded()
  await page.screenshot({
    path: path.join(root, 'artifacts/desktop-subtitle-studio.png'),
  })
  fixture.setMode('success')
  console.log(
    'PASS: multipart transcription with exact selected audio; immutable cue edits; explicit apply; stale voice and tampered SRT guards; bounded/uncertain responses; budget and key isolation. Local fixture only.',
  )
}
