import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect } from '@playwright/test'

// Billable, opt-in: one 1-second 480P first-frame request. Never resubmit on error.
export async function testLiveVideoRelay(page, root) {
  if (process.env.FRAME_STUDIO_LIVE_VIDEO !== '1') return
  const apiKey = process.env.FRAME_STUDIO_LIVE_VIDEO_KEY
  const imagePath = process.env.FRAME_STUDIO_LIVE_VIDEO_IMAGE
  const resumeReport = process.env.FRAME_STUDIO_LIVE_VIDEO_RESUME_REPORT
  if (!apiKey || (!imagePath && !resumeReport))
    throw new Error('Set live video key and image path.')
  const baseUrl =
    process.env.FRAME_STUDIO_LIVE_VIDEO_BASE_URL || 'https://api.wulusai.com'
  const invoke = (command, args = {}) =>
    page.evaluate(
      ({ command, args }) =>
        globalThis.__TAURI_INTERNALS__.invoke(command, args),
      { command, args },
    )
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const reportPath = path.join(
    root,
    'artifacts',
    `live-video-relay-${stamp}.json`,
  )
  if (resumeReport) {
    if (!process.env.FRAME_STUDIO_LIVE_VIDEO_PROFILE)
      throw new Error('Resume requires the original test profile.')
    const report = JSON.parse(await readFile(resumeReport, 'utf8'))
    if (!report.job?.taskId || report.job.request.wulusai.baseUrl !== baseUrl)
      throw new Error('Resume requires a known task on the selected service.')
    report.generationPosts = 0
    report.resumedFrom = path.basename(resumeReport)
    report.error = null
    const save = () => writeFile(reportPath, JSON.stringify(report, null, 2))
    await invoke('save_wulusai_video_key', { baseUrl, apiKey })
    try {
      const current = (
        await invoke('list_video_jobs', { workflowId: report.workflowId })
      ).find((j) => j.id === report.job.id)
      if (current?.status !== 'succeeded')
        await invoke('resume_video_job', { id: report.job.id })
      await waitForVideo(invoke, report, save)
      await checkPlayback(page, report, save)
      console.log(
        `PASS: original live task recovered without POST. Report: ${reportPath}`,
      )
    } finally {
      await invoke('clear_wulusai_video_key', { baseUrl })
    }
    return
  }
  const workflow = {
    schemaVersion: 1,
    id: '',
    name: '',
    updatedAt: Date.now(),
    viewport: { x: 0, y: 0, zoom: 1 },
    edges: [],
    nodes: [
      {
        id: 'storyboard',
        kind: 'storyboard',
        label: '分镜导演',
        position: { x: 0, y: 0 },
        config: {
          text: '',
          providerId: '',
          instructions: '',
          temperature: 0.3,
          shotCount: 1,
          duration: 1,
        },
        stale: false,
        output: null,
      },
    ],
  }
  workflow.id = `live-video-${Date.now()}`
  workflow.name = '真实首帧视频验证'
  const board = workflow.nodes.find((n) => n.kind === 'storyboard')
  board.stale = false
  board.output = {
    id: 'live-board',
    kind: 'storyboard',
    createdAt: Date.now(),
    source: 'manual',
    value: {
      shots: [
        {
          id: 'boat',
          title: '红纸船',
          description: '安静的湖面',
          duration: 1,
          camera: '静止',
          characters: [],
          dialogue: '',
          imagePrompt: 'red boat',
          videoPrompt:
            'The red paper boat gently floats on the calm lake. Locked camera, subtle ripples. Preserve the boat and composition.',
        },
      ],
    },
  }
  workflow.updatedAt = Date.now()
  await invoke('save_workflow', { workflow })
  const context = {
    workflowId: workflow.id,
    nodeId: board.id,
    artifactId: board.output.id,
    shotId: 'boat',
  }
  const image = await invoke('import_image', {
    name: 'red-boat-first-frame.png',
    bytes: [...(await readFile(imagePath))],
  })
  await invoke('select_first_frame', { context, versionId: image.versionId })
  const report = {
    submittedAt: new Date().toISOString(),
    protocol: 'POST /v1/videos',
    generationPosts: 0,
    workflowId: workflow.id,
    job: null,
    asset: null,
    connection: null,
    error: null,
  }
  const save = () => writeFile(reportPath, JSON.stringify(report, null, 2))
  try {
    await invoke('save_wulusai_video_key', { baseUrl, apiKey })
    report.connection = await invoke('check_wulusai_video_connection', {
      baseUrl,
      model: 'grok-imagine-video-1.5-lite',
    })
    await save()
    const request = {
      context,
      firstFrameVersionId: image.versionId,
      region: 'singapore',
      prompt: board.output.value.shots[0].videoPrompt,
      negativePrompt: '',
      duration: 1,
      resolution: '480P',
      wulusai: {
        baseUrl,
        model: 'grok-imagine-video-1.5-lite',
        mode: 'frame',
        ratio: null,
        budgetReservationMicroUsd: 1000000,
      },
    }
    report.generationPosts = 1
    const started = await invoke('start_video_job', { request })
    report.job = started
    await save()
    console.log(`Live first-frame task submitted once: local job ${started.id}`)
    await waitForVideo(invoke, report, save)
    await checkPlayback(page, report, save)
    console.log(
      `PASS: live Grok first-frame video saved. Report: ${reportPath}`,
    )
  } catch (error) {
    report.error = String(error).replaceAll(apiKey, '[REDACTED_SECRET]')
    await save()
    // Do not attach an unsanitized provider error to the logged error chain.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(report.error)
  } finally {
    await invoke('clear_wulusai_video_key', { baseUrl })
  }
}

async function waitForVideo(invoke, report, save) {
  const id = report.job.id
  const workflowId = report.workflowId
  const deadline = Date.now() + 900000
  let previous = ''
  while (Date.now() < deadline) {
    const jobs = await invoke('list_video_jobs', { workflowId })
    report.job = jobs.find((j) => j.id === id)
    if (!report.job) throw new Error('Saved video job disappeared.')
    const state = `${report.job.status}:${report.job.taskId || ''}`
    if (state !== previous) {
      console.log(`Live video: ${state}`)
      previous = state
    }
    await save()
    if (
      ['succeeded', 'failed', 'unknown', 'paused'].includes(report.job.status)
    )
      break
    await delay(5000)
  }
  if (
    ['submitting', 'queued', 'running', 'downloading'].includes(
      report.job.status,
    )
  ) {
    if (report.job.taskId) await invoke('pause_video_job', { id })
    throw new Error(
      'Live deadline reached; inspect saved task ID before any further submission.',
    )
  }
  if (report.job.status !== 'succeeded')
    throw new Error(`Live task ${report.job.status}: ${report.job.message}`)
  const assets = await invoke('list_video_assets', {
    workflowId,
  })
  report.asset = assets.find((a) => a.versionId === report.job.assetId)
  if (!report.asset || report.asset.source !== 'wulusai-frame')
    throw new Error('Generated frame video asset was not saved.')
  await save()
}

async function checkPlayback(page, report, save) {
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByLabel('切换工作流').selectOption(report.workflowId)
  await page.getByRole('button', { name: '镜头视频', exact: true }).click()
  await page
    .getByRole('button', { name: '播放片段', exact: true })
    .first()
    .click()
  const video = page.getByLabel('镜头视频预览')
  await expect
    .poll(() => video.evaluate((el) => el.readyState), { timeout: 15000 })
    .toBeGreaterThanOrEqual(2)
  await video.evaluate(async (el) => {
    el.muted = true
    await el.play()
  })
  await expect
    .poll(() => video.evaluate((el) => el.currentTime), { timeout: 10000 })
    .toBeGreaterThan(0)
  report.playback = await video.evaluate((el) => ({
    duration: el.duration,
    width: el.videoWidth,
    height: el.videoHeight,
    currentTime: el.currentTime,
  }))
  await video.evaluate((el) => el.pause())
  await save()
}
