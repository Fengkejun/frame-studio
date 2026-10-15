import { expect, test } from '@playwright/test'
import { makeWorkflow } from '../src/features/workflow/model'

test('video relay keeps credentials bound to its address and sends explicit planning settings', async ({
  page,
}) => {
  const workflow = makeWorkflow()
  const board = workflow.nodes.find((n) => n.kind === 'storyboard')!
  board.stale = false
  board.output = {
    id: 'board-output',
    kind: 'storyboard',
    createdAt: Date.now(),
    source: 'manual',
    value: {
      shots: [
        {
          id: 'shot',
          title: '纸船',
          description: '安静的湖面',
          duration: 5,
          characters: [],
          dialogue: '',
          camera: '静止',
          imagePrompt: 'red boat',
          videoPrompt: 'A red paper boat on a quiet lake.',
        },
      ],
    },
  }
  const context = {
    workflowId: workflow.id,
    nodeId: board.id,
    artifactId: 'board-output',
    shotId: 'shot',
  }
  await page.addInitScript(
    ({ workflow, context }) => {
      const keys = new Set<string>()
      Object.assign(globalThis, {
        isTauri: true,
        __TAURI_INTERNALS__: {
          convertFileSrc: (value: string) => value,
          invoke: (command: string, args: Record<string, unknown> = {}) => {
            if (command === 'get_app_info')
              return Promise.resolve({
                name: 'Frame Studio',
                version: '0.1.0',
                platform: 'fixture',
                architecture: 'fixture',
              })
            if (command === 'list_workflows') return Promise.resolve([workflow])
            if (command === 'list_image_assets')
              return Promise.resolve([
                {
                  assetId: 'asset',
                  versionId: 'frame',
                  width: 256,
                  height: 256,
                  name: 'frame.png',
                  bytes: 10,
                  createdAt: Date.now(),
                  context,
                  jobId: null,
                  fileName: 'frame.png',
                  source: 'import',
                },
              ])
            if (command === 'list_first_frames')
              return Promise.resolve([{ context, versionId: 'frame' }])
            if (command === 'video_key_status') return Promise.resolve(false)
            if (command === 'wulusai_video_key_status')
              return Promise.resolve(keys.has(args.baseUrl as string))
            if (command === 'save_wulusai_video_key') {
              keys.add(args.baseUrl as string)
              return Promise.resolve()
            }
            if (command === 'check_wulusai_video_connection')
              return Promise.resolve({
                status: 'model_not_listed',
                modelListed: false,
                message: '密钥认证通过，但当前模型未出现在目录中。',
              })
            if (command === 'start_video_job') {
              Object.assign(globalThis, { submittedVideoFixture: args.request })
              return Promise.resolve({
                id: 'submitted',
                request: args.request,
                status: 'submitting',
                taskId: null,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                assetId: null,
                estimatedCostMicroUsd: 700000,
                message: '',
              })
            }
            if (command === 'get_media_budget')
              return Promise.resolve({
                limitMicroUsd: null,
                reservedMicroUsd: 0,
              })
            if (command === 'save_workflow') return Promise.resolve()
            if (command === 'image_preview')
              return Promise.resolve(
                'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAtcAAAAASUVORK5CYII=',
              )
            if (command.startsWith('list_')) return Promise.resolve([])
            return new Promise(() => {})
          },
        },
      })
    },
    { workflow, context },
  )
  await page.goto('/')
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByRole('button', { name: '镜头视频', exact: true }).click()
  await expect(page.getByLabel('视频服务', { exact: true })).toBeEnabled()
  await page.getByLabel('视频服务', { exact: true }).selectOption('relay')
  await expect(page.getByLabel('视频模型')).toHaveValue('minimax-h3')
  await expect(page.getByLabel('视频时长')).toHaveAttribute('min', '4')
  await page.getByLabel('中转站 API Key').fill('fixture-only')
  await page.getByRole('button', { name: '保存密钥', exact: true }).click()
  await expect(
    page.getByRole('button', { name: '提交文生视频任务', exact: true }),
  ).toBeEnabled()
  await page.getByRole('button', { name: '检查连接', exact: true }).click()
  await expect(
    page.getByText(/密钥认证通过，但当前模型未出现在目录中/),
  ).toBeVisible()
  await page.getByLabel('本次视频预算预留').fill('0.7')
  await page
    .getByRole('button', { name: '提交文生视频任务', exact: true })
    .click()
  const submitted = await page.evaluate(
    () =>
      (globalThis as unknown as { submittedVideoFixture: { wulusai: unknown } })
        .submittedVideoFixture,
  )
  expect(submitted.wulusai).toMatchObject({
    mode: 'text',
    ratio: null,
    budgetReservationMicroUsd: 700000,
    baseUrl: 'https://api.wulusai.com',
  })
  expect(JSON.stringify(submitted)).not.toContain('fixture-only')
  await page.getByLabel('视频模型').selectOption('grok-imagine-video-1.5-lite')
  await expect(page.getByLabel('视频时长')).toHaveAttribute('min', '1')
  await page.getByLabel('视频时长').fill('1')
  await page.getByLabel('视频分辨率').selectOption('480P')
  await expect(page.getByLabel('视频生成方式')).toHaveValue('frame')
  await page
    .getByRole('button', { name: '提交图生视频任务', exact: true })
    .click()
  const grok = await page.evaluate(
    () =>
      (
        globalThis as unknown as {
          submittedVideoFixture: {
            duration: number
            resolution: string
            wulusai: unknown
          }
        }
      ).submittedVideoFixture,
  )
  expect(grok).toMatchObject({
    duration: 1,
    resolution: '480P',
    wulusai: {
      model: 'grok-imagine-video-1.5-lite',
      mode: 'frame',
      ratio: null,
    },
  })
  await page.getByLabel('视频 API 根地址').fill('https://other.example.com')
  await page.getByLabel('视频 API 根地址').press('Tab')
  await expect(
    page.getByRole('button', { name: '提交图生视频任务', exact: true }),
  ).toBeDisabled()
  await expect(page.getByLabel('中转站 API Key')).toHaveValue('')
})
