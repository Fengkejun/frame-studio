import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'

const invoke = (page, command, args = {}) =>
  page.evaluate(
    ({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  )

export async function createVideoRelayFixture(root) {
  const clip = await readFile(path.join(root, 'tests/fixtures/clip.mp4'))
  const requests = []
  const polls = new Map()
  let mode = 'success'
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture')
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.end(
        JSON.stringify({
          object: 'list',
          data:
            mode === 'empty'
              ? []
              : [
                  'minimax-h3',
                  'grok-imagine-video-1.5-lite',
                  'sd2.0',
                  'sd2.0-fast',
                  'sd2.0-mini',
                  'sd2.5',
                ].map((id) => ({ id })),
        }),
      )
      return
    }
    if (
      req.method === 'POST' &&
      [
        '/v2/video_generation',
        '/v1/videos',
        '/api/v3/contents/generations/tasks',
      ].includes(url.pathname)
    ) {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const payload = JSON.parse(raw)
      const id = `relay-${requests.length + 1}`
      requests.push({
        id,
        path: url.pathname,
        payload,
        authorization: req.headers.authorization,
        asyncHeader: req.headers['x-dashscope-async'],
      })
      if (mode === 'lost') {
        req.socket.destroy()
        return
      }
      if (mode === 'reject') {
        res.writeHead(403).end(
          JSON.stringify({
            error: { message: 'Insufficient credit', type: 'billing_error' },
          }),
        )
        return
      }
      res.end(
        JSON.stringify(
          url.pathname !== '/v2/video_generation'
            ? { id, status: 'queued' }
            : { task_id: id },
        ),
      )
      return
    }
    if (
      req.method === 'GET' &&
      (url.pathname.startsWith('/v2/query/video_generation/') ||
        url.pathname.startsWith('/v1/videos/') ||
        url.pathname.startsWith('/api/v3/contents/generations/tasks/'))
    ) {
      const id = url.pathname.split('/').at(-1)
      const count = (polls.get(id) ?? 0) + 1
      polls.set(id, count)
      if (url.pathname.startsWith('/api/v3/contents/generations/tasks/')) {
        res.end(
          JSON.stringify({
            id,
            status: count === 1 ? 'running' : 'succeeded',
            ...(count === 1 || mode === 'no-url'
              ? {}
              : {
                  content: {
                    video_url: `http://127.0.0.1:${server.address().port}/clip.mp4`,
                  },
                }),
          }),
        )
        return
      }
      if (url.pathname.startsWith('/v1/videos/')) {
        res.end(
          JSON.stringify({
            id,
            status:
              count === 1
                ? mode === 'unknown'
                  ? 'unknown'
                  : 'in_progress'
                : 'completed',
            ...(count === 1
              ? {}
              : {
                  metadata: {
                    url: `http://127.0.0.1:${server.address().port}/clip.mp4`,
                  },
                }),
          }),
        )
        return
      }
      if (mode === 'hold' || count === 1)
        res.end(JSON.stringify({ task: { id, status: 'running' } }))
      else if (mode === 'fail')
        res.end(
          JSON.stringify({
            task: {
              id,
              status: 'failed',
              error: { message: 'generation rejected' },
            },
          }),
        )
      else
        res.end(
          JSON.stringify({
            task_id: id,
            status: 'Success',
            file_url: `http://127.0.0.1:${server.address().port}/clip.mp4`,
          }),
        )
      return
    }
    if (req.method === 'GET' && url.pathname === '/clip.mp4') {
      res.setHeader('Content-Type', 'video/mp4')
      res.end(clip)
      return
    }
    res.writeHead(404).end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    polls,
    setMode: (next) => {
      mode = next
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

export async function testVideoRelay(page, fixture) {
  await page.getByRole('button', { name: '镜头视频', exact: true }).click()
  await page.getByLabel('视频服务', { exact: true }).selectOption('relay')
  await page.getByLabel('视频 API 根地址').fill(fixture.baseUrl)
  await page.getByLabel('视频 API 根地址').press('Tab')
  await expect(page.getByLabel('中转站 API Key')).toBeEnabled()
  await page.getByLabel('中转站 API Key').fill('fixture-relay-key')
  await page.getByRole('button', { name: '保存密钥', exact: true }).click()
  await expect(
    page.getByText('当前中转站密钥已保存在系统凭据库。'),
  ).toBeVisible()
  await page.getByRole('button', { name: '检查连接', exact: true }).click()
  await expect(
    page.getByText(/密钥认证通过，当前模型出现在目录中/),
  ).toBeVisible()
  fixture.setMode('empty')
  await page.getByRole('button', { name: '检查连接', exact: true }).click()
  await expect(page.getByText(/当前模型未出现在目录中/)).toBeVisible()
  fixture.setMode('success')
  await page.getByLabel('视频时长').fill('5')
  await page.getByLabel('本次视频预算预留').fill('0.7')
  const jobs = page.locator('.video-studio .image-job-history article')
  const count = await jobs.count()
  const chosenBefore = await page.locator('.video-candidates').textContent()
  await page
    .getByRole('button', { name: '提交文生视频任务', exact: true })
    .click()
  await expect(jobs).toHaveCount(count + 1)
  await expect(jobs.first().getByText('已保存', { exact: true })).toBeVisible({
    timeout: 20000,
  })
  expect(fixture.requests).toHaveLength(1)
  expect(fixture.requests[0].authorization).toBe('Bearer fixture-relay-key')
  expect(fixture.requests[0].asyncHeader).toBeUndefined()
  expect(fixture.requests[0].payload).toMatchObject({
    model: 'minimax-h3',
    duration: 5,
    resolution: '1080P',
  })
  expect(fixture.requests[0].payload.ratio).toBeUndefined()
  expect(fixture.requests[0].payload.content).toHaveLength(1)
  expect(fixture.requests[0].payload.content[0].type).toBe('text')
  expect(chosenBefore).toContain('已选片段版本')
  await expect(page.locator('.video-candidates')).toContainText('已选片段版本')
  const all = await invoke(page, 'list_workflows')
  const current = await page.getByLabel('切换工作流').inputValue()
  const workflow = all.find((w) => w.id === current)
  const saved = await invoke(page, 'list_video_jobs', {
    workflowId: workflow.id,
  })
  const latest = saved.find(
    (j) => j.request.wulusai && j.status === 'succeeded',
  )
  expect(latest.estimatedCostMicroUsd).toBe(700000)
  const assets = await invoke(page, 'list_video_assets', {
    workflowId: workflow.id,
  })
  expect(assets.find((a) => a.versionId === latest.assetId).source).toBe(
    'wulusai-text',
  )
  const invalid = await invoke(page, 'start_video_job', {
    request: { ...latest.request, duration: 3 },
  }).then(() => '', String)
  expect(invalid).toContain('请检查')
  expect(fixture.requests).toHaveLength(1)
  fixture.setMode('hold')
  const unadapted = await invoke(page, 'start_video_job', {
    request: {
      ...latest.request,
      wulusai: { ...latest.request.wulusai, model: 'unadapted-video-model' },
    },
  }).then(() => '', String)
  expect(unadapted).toContain('尚未适配')
  expect(fixture.requests).toHaveLength(1)
  const paused = await invoke(page, 'start_video_job', {
    request: latest.request,
  })
  await expect.poll(() => fixture.polls.get('relay-2') ?? 0).toBeGreaterThan(0)
  await invoke(page, 'pause_video_job', { id: paused.id })
  await expect
    .poll(
      async () =>
        (
          await invoke(page, 'list_video_jobs', { workflowId: workflow.id })
        ).find((j) => j.id === paused.id)?.status,
    )
    .toBe('paused')
  await page.reload()
  fixture.setMode('success')
  await invoke(page, 'resume_video_job', { id: paused.id })
  await expect
    .poll(
      async () =>
        (
          await invoke(page, 'list_video_jobs', { workflowId: workflow.id })
        ).find((j) => j.id === paused.id)?.status,
      { timeout: 20000 },
    )
    .toBe('succeeded')
  expect(fixture.requests).toHaveLength(2)
  fixture.setMode('reject')
  const rejected = await invoke(page, 'start_video_job', {
    request: latest.request,
  })
  await expect
    .poll(
      async () =>
        (
          await invoke(page, 'list_video_jobs', { workflowId: workflow.id })
        ).find((j) => j.id === rejected.id)?.status,
    )
    .toBe('failed')
  fixture.setMode('lost')
  const lost = await invoke(page, 'start_video_job', {
    request: latest.request,
  })
  await expect
    .poll(
      async () =>
        (
          await invoke(page, 'list_video_jobs', { workflowId: workflow.id })
        ).find((j) => j.id === lost.id)?.status,
    )
    .toBe('unknown')
  expect(fixture.requests).toHaveLength(4)
  fixture.setMode('unknown')
  const grok = await invoke(page, 'start_video_job', {
    request: {
      ...latest.request,
      duration: 1,
      resolution: '480P',
      wulusai: {
        ...latest.request.wulusai,
        model: 'grok-imagine-video-1.5-lite',
        mode: 'frame',
        ratio: null,
      },
    },
  })
  await expect
    .poll(
      async () =>
        (
          await invoke(page, 'list_video_jobs', {
            workflowId: workflow.id,
          })
        ).find((j) => j.id === grok.id)?.status,
      { timeout: 20000 },
    )
    .toBe('paused')
  fixture.setMode('success')
  await invoke(page, 'resume_video_job', { id: grok.id })
  await expect
    .poll(
      async () =>
        (
          await invoke(page, 'list_video_jobs', {
            workflowId: workflow.id,
          })
        ).find((j) => j.id === grok.id)?.status,
      { timeout: 20000 },
    )
    .toBe('succeeded')
  expect(fixture.requests).toHaveLength(5)
  const frame = fixture.requests[4]
  expect(frame.path).toBe('/v1/videos')
  expect(frame.payload).toMatchObject({
    model: 'grok-imagine-video-1.5-lite',
    seconds: '1',
    size: '480p',
  })
  expect(frame.payload.ratio).toBeUndefined()
  expect(frame.payload.input_reference).toMatch(/^data:image\/jpeg;base64,/)
  const image = Buffer.from(
    frame.payload.input_reference.split(',')[1],
    'base64',
  )
  // Decode dimensions in the browser, independently of the Rust resize implementation.
  const dimensions = await page.evaluate(
    async (bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })
      const bitmap = await globalThis.createImageBitmap(blob)
      const result = [bitmap.width, bitmap.height]
      bitmap.close()
      return result
    },
    [...image],
  )
  expect(dimensions).toEqual([854, 480])
  const frameAssets = await invoke(page, 'list_video_assets', {
    workflowId: workflow.id,
  })
  expect(frameAssets.find((a) => a.jobId === grok.id).source).toBe(
    'wulusai-frame',
  )
  const statusOf = async (id) =>
    (await invoke(page, 'list_video_jobs', { workflowId: workflow.id })).find(
      (j) => j.id === id,
    )?.status
  // Fund five extra local fixture jobs while retaining later tests' headroom.
  const sdBudget = await invoke(page, 'get_media_budget', {
    workflowId: workflow.id,
  })
  if (sdBudget.limitMicroUsd !== null)
    await invoke(page, 'set_media_budget', {
      workflowId: workflow.id,
      limitMicroUsd:
        sdBudget.limitMicroUsd +
        5 * latest.request.wulusai.budgetReservationMicroUsd,
    })
  for (const model of ['sd2.0', 'sd2.0-fast', 'sd2.0-mini', 'sd2.5']) {
    const job = await invoke(page, 'start_video_job', {
      request: {
        ...latest.request,
        duration: 4,
        resolution: '720P',
        prompt: 'a red circle',
        negativePrompt: '',
        wulusai: {
          ...latest.request.wulusai,
          model,
          mode: 'text',
          ratio: null,
        },
      },
    })
    await expect
      .poll(() => statusOf(job.id), { timeout: 20000 })
      .toBe('succeeded')
    expect(fixture.requests.at(-1).path).toBe(
      '/api/v3/contents/generations/tasks',
    )
    expect(fixture.requests.at(-1).payload).toEqual({
      model,
      duration: 4,
      resolution: '720p',
      content: [{ type: 'text', text: 'a red circle' }],
    })
  }
  const sdRequest = {
    ...latest.request,
    duration: 4,
    resolution: '4K',
    prompt: '',
    negativePrompt: '',
    wulusai: {
      ...latest.request.wulusai,
      model: 'sd2.5',
      mode: 'frame',
      ratio: null,
    },
  }
  const beforeSdFrame = fixture.requests.length
  const invalidRatio = await invoke(page, 'start_video_job', {
    request: { ...sdRequest, wulusai: { ...sdRequest.wulusai, ratio: '16:9' } },
  }).then(() => '', String)
  expect(invalidRatio).toContain('请检查')
  expect(fixture.requests).toHaveLength(beforeSdFrame)
  fixture.setMode('no-url')
  const sdFrame = await invoke(page, 'start_video_job', { request: sdRequest })
  await expect
    .poll(() => statusOf(sdFrame.id), { timeout: 20000 })
    .toBe('paused')
  const sdPayload = fixture.requests.at(-1).payload
  expect(sdPayload).toMatchObject({
    model: 'sd2.5',
    duration: 4,
    resolution: '4k',
  })
  expect(sdPayload.content).toHaveLength(1)
  expect(sdPayload.content[0]).toMatchObject({
    type: 'image_url',
    role: 'first_frame',
  })
  expect(sdPayload.content[0].image_url.url).toMatch(
    /^data:image\/jpeg;base64,/,
  )
  expect(Object.keys(sdPayload).sort()).toEqual([
    'content',
    'duration',
    'model',
    'resolution',
  ])
  fixture.setMode('success')
  await invoke(page, 'resume_video_job', { id: sdFrame.id })
  await expect
    .poll(() => statusOf(sdFrame.id), { timeout: 20000 })
    .toBe('succeeded')
  expect(fixture.requests).toHaveLength(beforeSdFrame + 1)
  await invoke(page, 'clear_wulusai_video_key', { baseUrl: fixture.baseUrl })
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  console.log(
    'PASS: MiniMax/Grok and four SD models; native Ark text/first-frame, 4K, adaptive guard, exact fields, no invented download URL, original-task recovery, budgets and credential isolation. Local fixture only.',
  )
}
