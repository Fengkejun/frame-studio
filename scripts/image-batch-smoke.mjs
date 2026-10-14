import http from 'node:http'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { expect } from '@playwright/test'

const invoke = (page, command, args = {}) =>
  page.evaluate(
    ({ command, args }) => globalThis.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  )
export async function testImageBatches(page, root) {
  const png = await readFile(path.join(root, 'src-tauri/icons/128x128.png'))
  const requests = []
  const comfyRequests = []
  let holdComfy = true
  let held = null
  const server = http.createServer(async (req, res) => {
    if (req.url === '/prompt' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      comfyRequests.push(JSON.parse(body))
      res.end(
        JSON.stringify({
          prompt_id: `batch-comfy-${comfyRequests.length}`,
          node_errors: {},
        }),
      )
      return
    }
    if (req.url.startsWith('/history/')) {
      const id = req.url.split('/').at(-1)
      res.end(
        JSON.stringify(
          holdComfy
            ? {}
            : {
                [id]: {
                  status: { status_str: 'success', completed: true },
                  outputs: {
                    9: {
                      images: [
                        {
                          filename: 'candidate.png',
                          subfolder: '',
                          type: 'output',
                        },
                      ],
                    },
                  },
                },
              },
        ),
      )
      return
    }
    if (req.url.startsWith('/view')) {
      res.setHeader('Content-Type', 'image/png')
      res.end(png)
      return
    }
    if (req.method !== 'POST' || req.url !== '/v1/images/generations') {
      res.writeHead(404).end()
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    if (requests.length === 1) {
      held = res
      return
    }
    if (requests.length === 2) {
      res
        .writeHead(400)
        .end(JSON.stringify({ error: { message: 'fixture known rejection' } }))
      return
    }
    if (requests.length === 5) {
      res.destroy()
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  try {
    const workflow = (await invoke(page, 'list_workflows')).find(
      (w) => w.name === '转场与声音效果验证',
    )
    const frames = await invoke(page, 'list_first_frames', {
      workflowId: workflow.id,
    })
    const budget = await invoke(page, 'get_media_budget', {
      workflowId: workflow.id,
    })
    await invoke(page, 'set_media_budget', {
      workflowId: workflow.id,
      limitMicroUsd: budget.reservedMicroUsd + 500000,
    })
    await page.getByRole('button', { name: '首帧与素材', exact: true }).click()
    await page.getByRole('button', { name: '云端生图', exact: true }).click()
    await page.getByLabel('云端图片 API 根地址').fill(baseUrl)
    await page.getByLabel('云端图片 API Key').fill('fixture-key')
    await page.getByRole('button', { name: '保存密钥', exact: true }).click()
    await expect(page.getByText('密钥已保存在系统凭据库')).toBeVisible()
    await page.getByText('批量生成镜头候选', { exact: true }).click()
    await page
      .getByRole('button', { name: '选择全部镜头', exact: true })
      .click()
    await page
      .getByRole('button', { name: '提交批量图片队列', exact: true })
      .click()
    await expect(page.getByRole('alert')).toContainText(
      '批量预留金额超过项目剩余预算',
    )
    expect(requests).toHaveLength(0)
    await invoke(page, 'set_media_budget', {
      workflowId: workflow.id,
      limitMicroUsd: budget.reservedMicroUsd + 5000000,
    })
    await page
      .getByRole('button', { name: '提交批量图片队列', exact: true })
      .click()
    await expect.poll(() => requests.length).toBe(1)
    const batchCard = page.locator('.image-batch').first()
    await expect(batchCard).toContainText('运行中')
    await batchCard
      .getByRole('button', { name: '暂停队列', exact: true })
      .click()
    await expect(batchCard).toContainText('已暂停')
    held.setHeader('Content-Type', 'application/json')
    held.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }))
    const first = (
      await invoke(page, 'list_image_batches', { workflowId: workflow.id })
    )[0]
    await expect
      .poll(
        async () =>
          (
            await invoke(page, 'list_cloud_image_jobs', {
              workflowId: workflow.id,
            })
          ).find((j) => j.id === first.items[0].jobId)?.status,
      )
      .toBe('succeeded')
    await page.reload()
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    await page.getByRole('button', { name: '首帧与素材', exact: true }).click()
    await expect(batchCard).toContainText('已暂停')
    expect(requests).toHaveLength(1)
    await batchCard
      .getByRole('button', { name: '继续队列', exact: true })
      .click()
    await expect(batchCard).toContainText('2/3 个镜头完成', { timeout: 20000 })
    await expect
      .poll(
        async () =>
          (
            await invoke(page, 'list_image_batches', {
              workflowId: workflow.id,
            })
          )[0].status,
      )
      .toBe('failed')
    expect(requests).toHaveLength(3)
    expect(new Set(requests.slice(0, 3).map((r) => r.prompt)).size).toBe(3)
    await batchCard
      .getByRole('button', { name: '重排失败项（可能计费）', exact: true })
      .click()
    await batchCard
      .getByRole('button', { name: '继续队列', exact: true })
      .click()
    await expect(batchCard).toContainText('3/3 个镜头完成', { timeout: 20000 })
    expect(requests).toHaveLength(4)
    const done = (
      await invoke(page, 'list_image_batches', { workflowId: workflow.id })
    )[0]
    expect(done.items[0].jobId).toBe(first.items[0].jobId)
    expect(done.items[1].previousJobIds).toHaveLength(1)
    // A lost response pauses the queue, and an explicit skip never resubmits it.
    await page.getByRole('button', { name: '云端生图', exact: true }).click()
    await page.getByLabel('云端图片 API 根地址').fill(baseUrl)
    await page.getByText('批量生成镜头候选', { exact: true }).click()
    await page
      .getByRole('button', { name: '选择全部镜头', exact: true })
      .click()
    await page
      .getByRole('button', { name: '提交批量图片队列', exact: true })
      .click()
    await expect(batchCard).toContainText('结果未知', { timeout: 20000 })
    const uncertain = (
      await invoke(page, 'list_image_batches', { workflowId: workflow.id })
    )[0]
    const rejection = await invoke(page, 'retry_image_batch_item', {
      id: uncertain.id,
      index: 0,
    }).then(() => 'unexpected success', String)
    expect(rejection).toContain('只有已知失败')
    await expect(
      batchCard.getByRole('button', { name: '继续队列', exact: true }),
    ).toBeDisabled()
    expect(requests).toHaveLength(5)
    await batchCard
      .getByRole('button', { name: '已核对，跳过未知项', exact: true })
      .click()
    await batchCard
      .getByRole('button', { name: '继续队列', exact: true })
      .click()
    await expect(batchCard).toContainText('2/3 个镜头完成', { timeout: 20000 })
    await expect
      .poll(
        async () =>
          (
            await invoke(page, 'list_image_batches', {
              workflowId: workflow.id,
            })
          )[0].status,
      )
      .toBe('succeeded')
    expect(requests).toHaveLength(7)
    expect(
      await invoke(page, 'list_first_frames', { workflowId: workflow.id }),
    ).toEqual(frames)
    const storyboard = workflow.nodes.find((n) => n.kind === 'storyboard')
    const local = await invoke(page, 'start_image_batch', {
      requests: storyboard.output.value.shots.map((shot) => ({
        kind: 'comfy',
        request: {
          context: {
            workflowId: workflow.id,
            nodeId: storyboard.id,
            artifactId: storyboard.output.id,
            shotId: shot.id,
          },
          baseUrl: baseUrl.replace('/v1', ''),
          checkpoint: 'fixture-sd.safetensors',
          positive: shot.imagePrompt,
          negative: '',
          width: 512,
          height: 768,
          steps: 20,
          seed: 1,
          count: 1,
          workflowJson: '',
          outputNodeId: '',
          referenceVersionId: null,
        },
      })),
    })
    await expect.poll(() => comfyRequests.length).toBe(1)
    await expect
      .poll(
        async () =>
          (
            await invoke(page, 'list_image_jobs', { workflowId: workflow.id })
          ).find((j) => j.id === local.items[0].jobId)?.status,
      )
      .toBe('waiting')
    await invoke(page, 'pause_image_batch', { id: local.id })
    await invoke(page, 'pause_image_job', { id: local.items[0].jobId })
    await expect
      .poll(
        async () =>
          (
            await invoke(page, 'list_image_jobs', { workflowId: workflow.id })
          ).find((j) => j.id === local.items[0].jobId)?.status,
      )
      .toBe('paused')
    await expect
      .poll(
        async () =>
          (
            await invoke(page, 'list_image_batches', {
              workflowId: workflow.id,
            })
          )[0].items[0].status,
      )
      .toBe('paused')
    holdComfy = false
    await invoke(page, 'resume_image_batch', { id: local.id })
    await expect
      .poll(
        async () =>
          (
            await invoke(page, 'list_image_batches', {
              workflowId: workflow.id,
            })
          )[0].status,
        { timeout: 20000 },
      )
      .toBe('succeeded')
    expect(comfyRequests).toHaveLength(3)
    await page
      .locator('.image-batch-history')
      .screenshot({ path: path.join(root, 'artifacts/image-batch-queue.png') })
    console.log(
      'PASS: genuine cloud/Comfy batch IPC; three independent prompts; total budget preflight; sequential dispatch; pause/reload; known failure retry; unknown-response stop/skip; Comfy resume original task without POST; unchanged frame choices. Local fixtures only.',
    )
  } finally {
    await invoke(page, 'clear_cloud_image_key', { baseUrl }).catch(() => {})
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}
