import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'

// A protocol fixture, not a model. Tests real desktop IPC, HTTP, files and SQLite.
export async function testMedia(page, root) {
  const png = await readFile(path.join(root, 'src-tauri/icons/128x128.png'))
  const submissions = []
  let hold = false
  let fail = false
  let reject = false
  let downloadFails = false
  let loseResponse = false
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    res.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/object_info/CheckpointLoaderSimple') {
      res.end(
        JSON.stringify({
          CheckpointLoaderSimple: {
            input: { required: { ckpt_name: [['fixture-sd.safetensors']] } },
          },
        }),
      )
    } else if (url.pathname === '/prompt') {
      let body = ''
      for await (const chunk of req) body += chunk
      const payload = JSON.parse(body)
      if (reject) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'fixture rejection' }))
        return
      }
      submissions.push(payload)
      if (loseResponse) {
        req.socket.destroy()
        return
      }
      res.end(
        JSON.stringify({
          prompt_id: `fixture-${submissions.length}`,
          number: submissions.length,
          node_errors: {},
        }),
      )
    } else if (url.pathname.startsWith('/history/')) {
      if (hold) {
        res.end('{}')
        return
      }
      const id = url.pathname.split('/').at(-1)
      const n = Number(id.split('-').at(-1)) - 1
      const count = submissions[n].prompt['5'].inputs.batch_size
      res.end(
        JSON.stringify({
          [id]: {
            status: {
              status_str: fail ? 'error' : 'success',
              completed: !fail,
            },
            outputs: {
              9: {
                images: Array.from({ length: count }, (_, index) => ({
                  filename: `fixture-${index}.png`,
                  subfolder: 'test',
                  type: 'output',
                })),
              },
            },
          },
        }),
      )
    } else if (url.pathname === '/view') {
      if (downloadFails) {
        res.writeHead(503)
        res.end('{}')
        return
      }
      res.setHeader('Content-Type', 'image/png')
      res.end(png)
    } else {
      res.writeHead(404)
      res.end('{}')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const shot = {
    id: 'shot-01',
    title: '雨夜书店',
    description: '猫走过温暖的书店橱窗',
    duration: 5,
    characters: ['猫'],
    dialogue: '',
    camera: '中景缓慢推进',
    imagePrompt:
      'A cat outside a warm bookshop on a rainy night, cinematic light',
    videoPrompt: 'Slow push in toward the cat',
  }
  const storyboard = { shots: [shot] }
  const workflow = {
    schemaVersion: 1,
    id: 'media-fixture-workflow',
    name: '首帧闭环测试',
    viewport: { x: 0, y: 0, zoom: 1 },
    updatedAt: Date.now(),
    edges: [
      {
        id: 'storyboard-to-image',
        source: 'storyboard-fixture',
        target: 'image-fixture',
      },
    ],
    nodes: [
      {
        id: 'storyboard-fixture',
        kind: 'storyboard',
        label: '分镜导演',
        position: { x: 80, y: 80 },
        config: {
          text: '',
          providerId: '',
          instructions: '',
          temperature: 0.7,
          shotCount: 1,
          duration: 5,
        },
        output: {
          id: 'storyboard-version-1',
          kind: 'storyboard',
          value: storyboard,
          source: 'manual',
          createdAt: Date.now(),
        },
        stale: false,
      },
      {
        id: 'image-fixture',
        kind: 'image',
        label: '图片节点',
        position: { x: 420, y: 80 },
        config: {
          text: '',
          providerId: '',
          instructions: '',
          temperature: 0.7,
          shotCount: 1,
          duration: 5,
        },
        output: null,
        stale: false,
      },
    ],
  }
  async function confirmStoryboard(value) {
    await page
      .locator('.react-flow__node')
      .filter({ hasText: '分镜导演' })
      .click()
    await page.getByRole('button', { name: '编辑结构化结果' }).click()
    await page
      .getByRole('textbox', { name: '结果 JSON' })
      .fill(JSON.stringify(value))
    await page.getByRole('button', { name: '校验并保存结果' }).click()
    await expect(
      page.getByRole('button', { name: '编辑结构化结果' }),
    ).toBeVisible()
  }
  async function openStudio() {
    await page.getByRole('button', { name: '首帧与素材', exact: true }).click()
    await expect(
      page.getByRole('heading', { name: '让分镜成为画面' }),
    ).toBeVisible()
  }
  async function generate() {
    await page.getByRole('button', { name: /生成 \d 张候选图/ }).click()
  }
  async function selectImageNode() {
    await page
      .locator('.canvas-area')
      .evaluate((element) =>
        element.scrollIntoView({ block: 'start', behavior: 'instant' }),
      )
    await page
      .locator('.react-flow__node')
      .filter({ hasText: '图片节点' })
      .locator('.node-mark')
      .click()
  }
  const jobs = page.locator('.image-job-history article')
  try {
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    await page.locator('input[type=file][accept=".json"]').setInputFiles({
      name: 'fixture.frame.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(workflow)),
    })
    await expect(page.getByRole('textbox', { name: '工作流名称' })).toHaveValue(
      '首帧闭环测试（导入）',
    )
    await confirmStoryboard(storyboard)
    await selectImageNode()
    await expect(page.getByText('已确认首帧 0 / 1')).toBeVisible()
    await page.getByRole('button', { name: '汇集已选首帧' }).click()
    await page.getByRole('button', { name: '开始执行' }).click()
    await expect(page.locator('.run-history > details').first()).toContainText(
      '等待首帧',
    )
    await page.getByRole('button', { name: '分镜故事板' }).click()
    await page.getByRole('button', { name: '制作首帧', exact: true }).click()
    await page.getByRole('button', { name: '本机 ComfyUI' }).click()
    await expect(
      page.getByRole('textbox', { name: '生图正面提示词' }),
    ).toHaveValue(shot.imagePrompt)
    await page.getByRole('textbox', { name: 'ComfyUI 地址' }).fill(baseUrl)
    await page.getByRole('button', { name: '检测连接与模型' }).click()
    await expect(page.getByText('连接成功 · 1 个模型')).toBeVisible()
    await page.getByRole('spinbutton', { name: '候选数量' }).fill('2')
    await page.getByRole('spinbutton', { name: '随机种子 Seed' }).fill('42')
    await generate()
    await expect(jobs.first().getByText('已完成', { exact: true })).toBeVisible(
      { timeout: 20000 },
    )
    expect(submissions).toHaveLength(1)
    expect(submissions[0].prompt['6'].inputs.text).toBe(shot.imagePrompt)
    expect(submissions[0].prompt['3'].inputs.seed).toBe(42)
    await expect(page.locator('.asset-card')).toHaveCount(2)
    await page
      .getByRole('button', { name: '选为首帧', exact: true })
      .first()
      .click()
    await page.getByRole('button', { name: '确认使用此版本' }).click()
    await expect(page.locator('.first-frame-target')).toContainText(
      '已选定镜头首帧',
    )
    const firstFrame = await page.locator('.first-frame-target').textContent()
    await selectImageNode()
    await expect(page.getByText('已确认首帧 1 / 1')).toBeVisible()
    await page.getByRole('button', { name: '汇集已选首帧' }).click()
    await page.getByRole('button', { name: '开始执行' }).click()
    await expect(page.locator('.node-inspector .output-preview')).toContainText(
      '1 个首帧版本',
    )
    await expect(page.locator('.node-inspector .output-preview')).toContainText(
      'shot-01',
    )
    await expect(
      page.locator('.node-inspector .output-preview img'),
    ).toBeVisible()
    await page.screenshot({
      path: path.join(root, 'artifacts/desktop-image-node.png'),
    })
    await openStudio()
    await page.getByRole('button', { name: '本机 ComfyUI' }).click()

    // Pause and resume: one POST only, even after a WebView reload.
    hold = true
    await generate()
    await expect(
      jobs.first().getByText('生成中', { exact: true }),
    ).toBeVisible()
    await jobs.first().getByRole('button', { name: '停止等待' }).click()
    await expect(
      jobs.first().getByText('待继续查询', { exact: true }),
    ).toBeVisible({ timeout: 10000 })
    expect(submissions).toHaveLength(2)
    await page.reload()
    await page.getByRole('button', { name: '工作流', exact: true }).click()
    await openStudio()
    await page.getByRole('button', { name: '本机 ComfyUI' }).click()
    await expect(page.locator('.first-frame-target')).toHaveText(firstFrame)
    hold = false
    await jobs.first().getByRole('button', { name: '继续查询原任务' }).click()
    await expect(jobs.first().getByText('已完成', { exact: true })).toBeVisible(
      { timeout: 15000 },
    )
    expect(submissions).toHaveLength(2)
    await expect(page.locator('.asset-card')).toHaveCount(4)
    await expect(page.locator('.first-frame-target')).toHaveText(firstFrame)

    // Download failure retains prompt ID and resumes without another generation.
    downloadFails = true
    await generate()
    await expect(
      jobs.first().getByText('待继续查询', { exact: true }),
    ).toBeVisible({ timeout: 15000 })
    downloadFails = false
    await jobs.first().getByRole('button', { name: '继续查询原任务' }).click()
    await expect(jobs.first().getByText('已完成', { exact: true })).toBeVisible(
      { timeout: 15000 },
    )
    expect(submissions).toHaveLength(3)
    await expect(page.locator('.asset-card')).toHaveCount(6)

    // Both execution errors and validation rejection must be terminal, not successes.
    fail = true
    await generate()
    await expect(jobs.first().getByText('失败', { exact: true })).toBeVisible({
      timeout: 15000,
    })
    fail = false
    reject = true
    await generate()
    await expect(jobs).toHaveCount(5)
    await expect(jobs.first().getByText('失败', { exact: true })).toBeVisible({
      timeout: 15000,
    })
    reject = false
    loseResponse = true
    await generate()
    await expect(jobs).toHaveCount(6)
    await expect(
      jobs.first().getByText('提交结果未知', { exact: true }),
    ).toBeVisible({ timeout: 15000 })
    await expect(
      jobs.first().getByRole('button', { name: '继续查询原任务' }),
    ).toHaveCount(0)
    expect(submissions).toHaveLength(5)
    loseResponse = false
    await page.getByLabel('导入本地图片').setInputFiles({
      name: '导入参考图.png',
      mimeType: 'image/png',
      buffer: png,
    })
    await expect(page.locator('.asset-card')).toHaveCount(7)
    const dropZone = page.locator('.first-frame-target')
    // Keep both ends visible; moving across a scrolling container can cancel a native drag.
    await dropZone.evaluate((element) =>
      element.scrollIntoView({ block: 'start', behavior: 'instant' }),
    )
    const card = page
      .locator('.asset-card')
      .filter({ hasText: '导入参考图.png' })
    await expect(card).toHaveAttribute('draggable', 'true')
    const from = await card.boundingBox()
    const to = await dropZone.boundingBox()
    await page.mouse.move(from.x + 30, from.y + 30)
    await page.mouse.down()
    await page.mouse.move(from.x + 50, from.y + 35, { steps: 5 })
    await page.mouse.move(to.x + 40, to.y + 40, { steps: 15 })
    await page.mouse.move(to.x + 45, to.y + 45)
    await page.mouse.up()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: '确认使用此版本' }).click()
    await expect(page.locator('.asset-card.is-selected')).toContainText(
      '导入参考图.png',
    )
    await expect(
      page
        .locator('.react-flow__node')
        .filter({ hasText: '图片节点' })
        .getByText('待更新'),
    ).toBeVisible()
    await page.getByLabel('导入本地图片').setInputFiles({
      name: 'bad.png',
      mimeType: 'image/png',
      buffer: Buffer.from('not an image'),
    })
    await expect(page.getByRole('alert')).toContainText('仅支持 PNG')
    await page.getByRole('alert').getByRole('button', { name: '关闭' }).click()
    await page
      .locator('.image-studio-top')
      .evaluate((element) =>
        element.scrollIntoView({ block: 'start', behavior: 'instant' }),
      )
    await page.screenshot({
      path: path.join(root, 'artifacts/desktop-image-studio.png'),
    })

    // A new storyboard result must not inherit an old first-frame binding.
    await confirmStoryboard({
      shots: [{ ...shot, imagePrompt: 'New storyboard version' }],
    })
    await expect(page.locator('.first-frame-target')).toContainText(
      '等待选择首帧',
    )
    await selectImageNode()
    await expect(page.getByText('已确认首帧 0 / 1')).toBeVisible()
    await page.getByRole('button', { name: '汇集已选首帧' }).click()
    await page.getByRole('button', { name: '开始执行' }).click()
    await expect(page.locator('.run-history > details').first()).toContainText(
      '等待首帧',
    )
    await openStudio()
    await page.getByRole('button', { name: '本地素材库', exact: true }).click()
    await expect(page.locator('.asset-card')).toHaveCount(7)
    console.log(
      'PASS: real native image IPC, HTTP protocol, candidate persistence, explicit selection, resume without resubmit, errors, imports and storyboard version isolation. Fixture images only; no AI inference.',
    )
  } catch (error) {
    await page.screenshot({
      path: path.join(root, 'artifacts/media-failure.png'),
      fullPage: true,
    })
    throw error
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}
