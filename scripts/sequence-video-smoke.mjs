import { expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// Real desktop IPC and UI; request 12 seconds, return a local 13-second AV fixture.
// The timeline must preserve the actual result rather than trim to the request.
export async function testSequenceVideo(page, root, profile, relay) {
  const invoke = (command, args = {}) =>
    page.evaluate(
      ({ command, args }) =>
        globalThis.__TAURI_INTERNALS__.invoke(command, args),
      { command, args },
    )
  const previous = await invoke('get_default_workflow')
  const previousSettings = await page.evaluate(() =>
    localStorage.getItem('frame-studio.video-settings'),
  )
  const source = (await invoke('list_workflows')).find((w) =>
    w.nodes.some((n) => n.id === 'timeline-fixture'),
  )
  const workflow = structuredClone(source)
  workflow.id = `sequence-${Date.now()}`
  workflow.name = '整段三分镜本机验证'
  workflow.production = {
    style: '固定二维动漫',
    characters: '固定蓝衣白发邮差和橘白猫',
    scene: '雨夜屋顶，不下雪',
    rules: '同一封信，动作连续',
  }
  const board = workflow.nodes.find((n) => n.kind === 'storyboard')
  board.output.id = `sequence-board-${Date.now()}`
  board.output.value.shots = [1, 2, 3].map((i) => ({
    ...board.output.value.shots[0],
    id: `whole-${i}`,
    duration: 4,
    title: `分镜 ${i}`,
    videoPrompt: `连续动作 ${i}`,
  }))
  const videoNode = workflow.nodes.find((n) => n.kind === 'video')
  const imageNode = workflow.nodes.find((n) => n.kind === 'image')
  workflow.nodes = workflow.nodes.filter((n) => n !== imageNode)
  workflow.edges = workflow.edges.filter(
    (e) =>
      e.source !== imageNode?.id &&
      e.target !== imageNode?.id &&
      e.target !== videoNode.id,
  )
  workflow.edges.push({
    id: 'sequence-edge',
    source: board.id,
    target: videoNode.id,
  })
  for (const n of workflow.nodes.filter((n) =>
    ['video', 'timeline'].includes(n.kind),
  )) {
    n.output = null
    n.stale = false
  }
  const firstShot = {
    workflowId: workflow.id,
    nodeId: board.id,
    artifactId: board.output.id,
    shotId: 'whole-1',
  }
  const settings = {
    region: 'singapore',
    resolution: '480P',
    wulusai: {
      baseUrl: relay.baseUrl,
      model: 'grok-imagine-video-1.5-lite',
      mode: 'text',
      ratio: null,
      budgetReservationMicroUsd: 500000,
    },
  }
  const originalBytes = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=128x128:r=24:d=13',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=13',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      '-movflags',
      'frag_keyframe+empty_moov',
      '-f',
      'mp4',
      '-',
    ],
    { windowsHide: true },
  )
  relay.setClip(originalBytes)
  relay.setMode('success')
  const before = relay.requests.length
  try {
    await invoke('save_workflow', { workflow })
    await invoke('set_default_workflow', { id: workflow.id })
    await invoke('save_wulusai_video_key', {
      baseUrl: relay.baseUrl,
      apiKey: 'fixture-relay-key',
    })
    await page.evaluate(
      (value) =>
        localStorage.setItem(
          'frame-studio.video-settings',
          JSON.stringify(value),
        ),
      settings,
    )
    await page.reload()
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    await page.getByRole('button', { name: '镜头视频', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: '整段分镜生成', exact: true }),
    ).toBeVisible()
    const prompt = page.getByLabel('视频提示词', { exact: true })
    await expect(prompt).toHaveValue(/0–4 秒/)
    await expect(prompt).toHaveValue(/4–8 秒/)
    await expect(prompt).toHaveValue(/8–12 秒/)
    await expect(prompt).toHaveValue(/固定蓝衣白发邮差和橘白猫/)
    await expect(page.getByLabel('视频时长')).toHaveValue('12')
    await expect(page.getByLabel('视频时长')).not.toBeEditable()
    await page
      .getByRole('button', { name: '一次提交整段分镜（12 秒）', exact: true })
      .click()
    await expect
      .poll(
        async () =>
          (await invoke('list_video_jobs', { workflowId: workflow.id }))[0]
            ?.status,
        { timeout: 25000 },
      )
      .toBe('succeeded')
    expect(relay.requests.length - before).toBe(1)
    const submitted = relay.requests.at(-1).payload
    expect(submitted.seconds).toBe('12')
    expect(submitted.prompt).toContain('连续动作 3')
    expect(submitted.input_reference).toBeUndefined()
    expect(
      await invoke('list_first_frames', { workflowId: workflow.id }),
    ).toHaveLength(0)
    const job = (
      await invoke('list_video_jobs', { workflowId: workflow.id })
    )[0]
    const asset = (
      await invoke('list_video_assets', { workflowId: workflow.id })
    )[0]
    expect(asset.sequence.shotIds).toEqual(['whole-1', 'whole-2', 'whole-3'])
    expect(asset.metadata.durationMs).toBe(13000)
    await page
      .getByRole('button', { name: '选为整段版本', exact: true })
      .click()
    const run = await invoke('start_run', { workflow, target: videoNode.id })
    await expect
      .poll(async () => (await invoke('get_run', { id: run.id })).status)
      .toBe('succeeded')
    const result = (await invoke('get_run', { id: run.id })).nodes[0].output
      .value.clips
    expect(result).toHaveLength(1)
    expect(result[0].sequenceShotIds).toHaveLength(3)
    expect(result[0].duration).toBe(13)
    for (const patch of [
      { duration: 16 },
      { duration: 8 },
      { sequence: { shotIds: ['whole-3', 'whole-2', 'whole-1'] } },
      { prompt: '' },
    ]) {
      const error = await invoke('start_video_job', {
        request: { ...job.request, ...patch },
      }).then(() => '', String)
      expect(error).not.toBe('')
      expect(relay.requests.length - before).toBe(1)
    }
    await page
      .getByRole('button', { name: '时间线与导出', exact: true })
      .click()
    await expect(page.locator('.timeline-choice')).toHaveCount(1)
    await page.getByRole('button', { name: '按分镜装配全部已选镜头' }).click()
    await expect(page.getByLabel('片段 1 结束')).toHaveValue('13')
    const copy = path.join(profile, `sequence-original-${asset.versionId}.mp4`)
    await invoke('save_video_copy', {
      versionId: asset.versionId,
      outputPath: copy,
    })
    expect(await readFile(copy)).toEqual(originalBytes)
    const overwrite = await invoke('save_video_copy', {
      versionId: asset.versionId,
      outputPath: copy,
    }).then(() => '', String)
    expect(overwrite).toContain('已存在')
    expect(await readFile(copy)).toEqual(originalBytes)
    expect(relay.requests.length - before).toBe(1)
    // Changing shot duration must make the old whole version invalid for export/selection.
    board.output.value.shots[0].duration = 5
    await invoke('save_workflow', { workflow })
    const stale = await invoke('select_video', {
      context: firstShot,
      versionId: asset.versionId,
    }).then(() => '', String)
    expect(stale).toContain('总时长')
    console.log(
      'PASS: one 12-second video job for three timed storyboards; global continuity prompts; no first-frame prerequisite; direct video node; full-duration timeline; byte-identical AV copy and overwrite guard; duration/order/stale guards. Local fixture only; no AI inference.',
    )
  } finally {
    relay.setClip(await readFile(path.join(root, 'tests/fixtures/clip.mp4')))
    if (previous) await invoke('set_default_workflow', { id: previous })
    await page.evaluate((value) => {
      if (value === null) localStorage.removeItem('frame-studio.video-settings')
      else localStorage.setItem('frame-studio.video-settings', value)
    }, previousSettings)
    await page.reload()
    await page.getByRole('button', { name: '工作流', exact: true }).click()
  }
}
