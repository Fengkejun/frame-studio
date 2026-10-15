import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect } from '@playwright/test'

// Billable, opt-in: exactly one request. Resume reports never submit another job.
export async function testLiveVideoRelay(page, root, profile) {
  if (process.env.FRAME_STUDIO_LIVE_VIDEO !== '1') return
  const apiKey = process.env.FRAME_STUDIO_LIVE_VIDEO_KEY
  const imagePath = process.env.FRAME_STUDIO_LIVE_VIDEO_IMAGE
  const resumeReport = process.env.FRAME_STUDIO_LIVE_VIDEO_RESUME_REPORT
  if (!apiKey || (!imagePath && !resumeReport))
    throw new Error('Set live video key and image path.')
  const baseUrl =
    process.env.FRAME_STUDIO_LIVE_VIDEO_BASE_URL || 'https://api.wulusai.com'
  const catalog = JSON.parse(
    await readFile(path.join(root, 'src/shared/video-models.json'), 'utf8'),
  )
  const modelId =
    process.env.FRAME_STUDIO_LIVE_VIDEO_MODEL || 'grok-imagine-video-1.5-lite'
  const model = catalog.models.find((item) => item.id === modelId)
  const mode = process.env.FRAME_STUDIO_LIVE_VIDEO_MODE || 'frame'
  if (!model || !model.modes.includes(mode) || model.protocol === 'wan')
    throw new Error('Choose a registered relay model and supported mode.')
  // Use the shortest supported duration and lowest listed resolution.
  const duration = model.duration.min
  const resolution = model.resolutions[0]
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
    if (report.profile && report.profile !== profile)
      throw new Error('Resume must use the original native profile.')
    const savedJobs = await invoke('list_video_jobs', {
      workflowId: report.workflowId,
    })
    const current = savedJobs.find((j) =>
      report.job
        ? j.id === report.job.id
        : j.request.context.shotId === report.context?.shotId,
    )
    if (!current?.taskId || current.request.wulusai.baseUrl !== baseUrl)
      throw new Error('Resume requires a known task on the selected service.')
    report.job = current
    report.generationPosts = 0
    report.resumedFrom = path.basename(resumeReport)
    report.error = null
    const save = () => writeFile(reportPath, JSON.stringify(report, null, 2))
    await invoke('save_wulusai_video_key', { baseUrl, apiKey })
    try {
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
  let workflow = {
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
          duration,
        },
        stale: false,
        output: null,
      },
    ],
  }
  workflow.id = `live-video-${Date.now()}`
  workflow.name = '真实首帧视频验证'
  let board = workflow.nodes.find((n) => n.kind === 'storyboard')
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
          duration,
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
  let shot = board.output.value.shots[0]
  const projectReport = process.env.FRAME_STUDIO_LIVE_VIDEO_PROJECT_REPORT
  if (projectReport) {
    const previous = JSON.parse(await readFile(projectReport, 'utf8'))
    if (previous.profile !== profile || previous.job?.status !== 'succeeded')
      throw new Error(
        'Extending a live film requires its successful original report and profile.',
      )
    const workflows = await invoke('list_workflows')
    workflow = workflows.find((item) => item.id === previous.workflowId)
    board = workflow?.nodes.find((node) => node.id === previous.context.nodeId)
    if (!board || board.output?.id !== previous.context.artifactId)
      throw new Error(
        'The original storyboard changed; inspect it before another submission.',
      )
    const frames = await invoke('list_first_frames', {
      workflowId: workflow.id,
    })
    const unbound = board.output.value.shots.find(
      (item) => !frames.some((frame) => frame.context.shotId === item.id),
    )
    if (unbound) {
      Object.assign(unbound, shot, { id: unbound.id })
      shot = unbound
    } else {
      if (board.output.value.shots.length >= 3)
        throw new Error(
          'This acceptance film already has three shots; review existing jobs.',
        )
      shot = { ...shot, id: `boat-${Date.now()}` }
      board.output.value.shots.push(shot)
    }
    board.config.shotCount = board.output.value.shots.length
  }
  shot.videoPrompt =
    process.env.FRAME_STUDIO_LIVE_VIDEO_PROMPT || shot.videoPrompt
  workflow.updatedAt = Date.now()
  const context = {
    workflowId: workflow.id,
    nodeId: board.id,
    artifactId: board.output.id,
    shotId: shot.id,
  }
  const image = await invoke('import_image', {
    name: path.basename(imagePath),
    bytes: [...(await readFile(imagePath))],
  })
  await invoke('save_workflow', { workflow })
  // Reload the controller after this fixture's direct IPC edits so its queued
  // autosave cannot restore an older storyboard while the cloud job is checked.
  await page.reload()
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await expect(page.getByText('已保存到本机', { exact: true })).toBeVisible()
  await invoke('select_first_frame', { context, versionId: image.versionId })
  const report = {
    submittedAt: new Date().toISOString(),
    protocol: model.protocol,
    profile,
    context,
    model: modelId,
    mode,
    duration,
    resolution,
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
      model: modelId,
    })
    await save()
    const request = {
      context,
      firstFrameVersionId: image.versionId,
      region: 'singapore',
      prompt: shot.videoPrompt,
      negativePrompt: '',
      duration,
      resolution,
      wulusai: {
        baseUrl,
        model: modelId,
        mode,
        ratio: null,
        budgetReservationMicroUsd: 1000000,
      },
    }
    report.generationPosts = 1
    report.submissionAttemptedAt = new Date().toISOString()
    // Persist intent before IPC: a lost response must never cause an automatic retry.
    await save()
    const started = await invoke('start_video_job', { request })
    report.job = started
    await save()
    console.log(
      `Live ${modelId} ${mode} submitted once: local job ${started.id}`,
    )
    await waitForVideo(invoke, report, save)
    await checkPlayback(page, report, save)
    console.log(
      `PASS: live ${modelId} ${mode} video saved. Report: ${reportPath}`,
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
  if (
    !report.asset ||
    report.asset.source !== `wulusai-${report.job.request.wulusai.mode}`
  )
    throw new Error('Generated frame video asset was not saved.')
  await save()
}

async function checkPlayback(page, report, save) {
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByLabel('切换工作流').selectOption(report.workflowId)
  await page.getByRole('button', { name: '镜头视频', exact: true }).click()
  await page
    .getByLabel('视频目标镜头')
    .selectOption(
      `${report.job.request.context.nodeId}/${report.job.request.context.shotId}`,
    )
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
