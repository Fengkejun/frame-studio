import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { expect } from '@playwright/test'

const invoke = (page, command, args = {}) =>
  page.evaluate(
    ({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  )

export async function testVideoBatches(page, root, fixture) {
  const original = (await invoke(page, 'list_workflows')).find(
    (w) => w.name === '转场与声音效果验证',
  )
  const workflow = structuredClone(original)
  const storyboard = workflow.nodes.find((n) => n.kind === 'storyboard')
  storyboard.output.value.shots.forEach((s, i) => {
    s.videoPrompt = `Batch camera motion ${i}`
    s.duration = i + 2
  })
  const args = { workflowId: workflow.id }
  const frames = await invoke(page, 'list_first_frames', args)
  const selected = await invoke(page, 'list_selected_videos', args)
  const imageBatches = (await invoke(page, 'list_image_batches', args)).length
  const budget = await invoke(page, 'get_media_budget', args)
  const baseline = fixture.requests.length
  const getBatch = async (id) =>
    (await invoke(page, 'list_image_batches', args)).find((b) => b.id === id)
  const getJob = async (id) =>
    (await invoke(page, 'list_video_jobs', args)).find((j) => j.id === id)
  const timeout = { timeout: 30000 }
  try {
    await invoke(page, 'save_workflow', { workflow })
    await invoke(page, 'save_video_key', {
      region: 'singapore',
      apiKey: 'fixture-wan-key',
    })
    await page.reload()
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    await page.getByRole('button', { name: '镜头视频', exact: true }).click()
    const history = page.getByRole('region', {
      name: '视频批量队列',
      exact: true,
    })
    const card = history.locator('.image-batch').first()
    await expect(history.locator('.image-batch')).toHaveCount(0)
    await page.getByText('批量生成视频候选', { exact: true }).click()
    await page
      .getByRole('button', { name: '选择全部镜头', exact: true })
      .click()
    await expect(page.getByText(/合计标价预估 \$0.90/)).toBeVisible()
    await invoke(page, 'set_media_budget', {
      ...args,
      limitMicroUsd: budget.reservedMicroUsd + 100000,
    })
    await page
      .getByRole('button', { name: '提交批量视频队列', exact: true })
      .click()
    await expect(page.getByRole('alert')).toContainText(
      '批量预留金额超过项目剩余预算',
    )
    expect(fixture.requests).toHaveLength(baseline)
    await invoke(page, 'set_media_budget', {
      ...args,
      limitMicroUsd: budget.reservedMicroUsd + 10000000,
    })
    fixture.setMode('hold')
    fixture.setModes(['success', 'fail', 'success'])
    await page
      .getByRole('button', { name: '提交批量视频队列', exact: true })
      .click()
    await expect.poll(() => fixture.requests.length).toBe(baseline + 1)
    const batch = (await invoke(page, 'list_image_batches', args)).find(
      (b) => b.items[0].request.kind === 'video',
    )
    const firstId = batch.items[0].jobId
    await expect.poll(async () => (await getJob(firstId))?.taskId).toBeTruthy()
    const remoteId = (await getJob(firstId)).taskId
    await card.getByRole('button', { name: '暂停队列', exact: true }).click()
    await invoke(page, 'pause_video_job', { id: firstId })
    await expect
      .poll(async () => (await getJob(firstId))?.status, timeout)
      .toBe('paused')
    await expect
      .poll(async () => (await getBatch(batch.id)).items[0].status)
      .toBe('paused')
    fixture.setMode('success')
    await page.reload()
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    await page.getByRole('button', { name: '镜头视频', exact: true }).click()
    await expect(card).toContainText('已暂停')
    expect(fixture.requests).toHaveLength(baseline + 1)
    await card.getByRole('button', { name: '继续队列', exact: true }).click()
    await expect
      .poll(async () => (await getBatch(batch.id)).status, timeout)
      .toBe('failed')
    await expect(card).toContainText('2/3 个镜头完成')
    expect(fixture.requests).toHaveLength(baseline + 3)
    expect((await getJob(firstId)).taskId).toBe(remoteId)
    expect(
      fixture.requests
        .slice(baseline, baseline + 3)
        .map((r) => r.payload.input.prompt),
    ).toEqual(storyboard.output.value.shots.map((s) => s.videoPrompt))
    expect(
      fixture.requests
        .slice(baseline, baseline + 3)
        .map((r) => r.payload.parameters.duration),
    ).toEqual([2, 3, 4])
    await card
      .getByRole('button', { name: '重排失败项（可能计费）', exact: true })
      .click()
    await card.getByRole('button', { name: '继续队列', exact: true }).click()
    await expect
      .poll(async () => (await getBatch(batch.id)).status, timeout)
      .toBe('succeeded')
    expect(fixture.requests).toHaveLength(baseline + 4)
    const done = await getBatch(batch.id)
    expect(done.items[0].jobId).toBe(firstId)
    expect(done.items[1].previousJobIds).toEqual([batch.items[1].jobId])
    expect(done.items.every((i) => i.assetIds.length === 1)).toBe(true)
    const requests = batch.items.map((i) => i.request.request)
    fixture.setModes(['lost', 'success', 'success'])
    const uncertain = await invoke(page, 'start_video_batch', { requests })
    await expect
      .poll(async () => (await getBatch(uncertain.id)).status, timeout)
      .toBe('paused')
    expect((await getBatch(uncertain.id)).items[0].status).toBe('unknown')
    expect(
      await invoke(page, 'retry_image_batch_item', {
        id: uncertain.id,
        index: 0,
      }).then(() => 'unexpected success', String),
    ).toContain('只有已知失败')
    expect(
      await invoke(page, 'resume_image_batch', { id: uncertain.id }).then(
        () => 'unexpected success',
        String,
      ),
    ).toContain('先核对')
    expect(fixture.requests).toHaveLength(baseline + 5)
    await invoke(page, 'skip_unknown_image_batch_item', {
      id: uncertain.id,
      index: 0,
    })
    await invoke(page, 'resume_image_batch', { id: uncertain.id })
    await expect
      .poll(async () => (await getBatch(uncertain.id)).status, timeout)
      .toBe('succeeded')
    expect(fixture.requests).toHaveLength(baseline + 7)
    // Queue snapshots must reject a changed frame before sending the affected request.
    fixture.setMode('hold')
    const stale = await invoke(page, 'start_video_batch', { requests })
    await expect.poll(() => fixture.requests.length).toBe(baseline + 8)
    await invoke(page, 'pause_image_batch', { id: stale.id })
    const image = await invoke(page, 'import_image', {
      name: 'batch-new-frame.png',
      bytes: [
        ...(await readFile(path.join(root, 'src-tauri/icons/128x128@2x.png'))),
      ],
    })
    await invoke(page, 'select_first_frame', {
      context: requests[1].context,
      versionId: image.versionId,
    })
    fixture.setMode('success')
    await expect
      .poll(async () => (await getJob(stale.items[0].jobId))?.status, timeout)
      .toBe('succeeded')
    await invoke(page, 'resume_image_batch', { id: stale.id })
    await expect
      .poll(async () => (await getBatch(stale.id)).status, timeout)
      .toBe('failed')
    expect((await getBatch(stale.id)).items[1].message).toContain(
      '首帧版本已变化',
    )
    expect(fixture.requests).toHaveLength(baseline + 9)
    await invoke(page, 'select_first_frame', {
      context: requests[1].context,
      versionId: requests[1].firstFrameVersionId,
    })
    expect(await invoke(page, 'list_first_frames', args)).toEqual(frames)
    expect(await invoke(page, 'list_selected_videos', args)).toEqual(selected)
    await page.getByRole('button', { name: '首帧与素材', exact: true }).click()
    await expect(
      page
        .getByRole('region', { name: '图片批量队列', exact: true })
        .locator('.image-batch'),
    ).toHaveCount(imageBatches)
  } finally {
    fixture.setMode('success')
    fixture.setModes([])
    await invoke(page, 'clear_video_key', { region: 'singapore' })
    await invoke(page, 'save_workflow', { workflow: original })
    await page.reload()
    await page.getByRole('button', { name: '工作流', exact: true }).click()
  }
  return { submissions: fixture.requests.length - baseline, batches: 3 }
}
