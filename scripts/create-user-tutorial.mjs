import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import {
  openTutorialApp,
  recordTutorialPage,
  wait,
} from './tutorial-runtime.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.resolve(
  process.env.FRAME_STUDIO_TUTORIAL_DIR ||
    path.join(root, 'artifacts/user-guide-2026-10-15'),
)
const profile = path.join(directory, 'profile')
const bundlePath = path.join(directory, '真实云端媒体示例.framepack')
const mode = process.argv[2]
await mkdir(directory, { recursive: true })

async function configure(page) {
  const key = process.env.FRAME_STUDIO_LIVE_TEXT_KEY
  assert.ok(key, 'Supply the text key through the process environment.')
  await page.getByRole('button', { name: '模型连接', exact: true }).click()
  const existing = page
    .locator('.connection-item')
    .filter({ hasText: 'Vectio · Grok 4.7' })
  if (await existing.count()) await existing.first().click()
  else await page.getByRole('button', { name: '＋ 新建', exact: true }).click()
  await page.getByLabel('连接名称').fill('Vectio · Grok 4.7')
  await page.getByLabel('接入方式').selectOption('openai')
  await page.getByLabel('API 根地址').fill('https://vectio.cc/v1')
  await page.getByLabel('模型 ID', { exact: true }).fill('grok-4.7')
  await page.getByLabel('API Key', { exact: false }).fill(key)
  await page.getByRole('button', { name: '测试连接', exact: true }).click()
  await expect(page.getByText(/连接正常，已找到配置的模型/)).toBeVisible({
    timeout: 30000,
  })
  await page.getByRole('button', { name: '测试模型回复', exact: true }).click()
  await expect(page.getByText(/模型回复验证通过/)).toBeVisible({
    timeout: 100000,
  })
}

async function prepare() {
  const sourceReport = JSON.parse(
    await readFile(
      path.join(root, 'artifacts/sd-three-shot-2026-10-15T08-35-59-476Z.json'),
      'utf8',
    ),
  )
  const source = await openTutorialApp(
    root,
    path.join(directory, 'source-webview'),
    sourceReport.profile,
    {
      FRAME_STUDIO_TEST_PROJECT_BUNDLE_PATH: bundlePath,
    },
  )
  try {
    await source.invoke('export_project_bundle', {
      workflowId: sourceReport.workflowId,
    })
  } finally {
    await source.close()
  }
  const app = await openTutorialApp(root, profile, profile, {
    FRAME_STUDIO_TEST_PROJECT_BUNDLE_PATH: bundlePath,
  })
  try {
    const media = await app.invoke('import_project_bundle')
    media.name = '媒体流程演示 · 真实云端素材'
    media.updatedAt = Date.now()
    await app.invoke('save_workflow', { workflow: media })
    const provider = await app.invoke('save_provider', {
      provider: {
        id: `guide-grok-${randomUUID()}`,
        name: 'Vectio · Grok 4.7',
        kind: 'openai',
        baseUrl: 'https://vectio.cc/v1',
        model: 'grok-4.7',
        hasKey: false,
      },
      apiKey: process.env.FRAME_STUDIO_LIVE_TEXT_KEY,
      clearKey: false,
    })
    const kinds = [
      'brief',
      'story',
      'storyboard',
      'prompt',
      'image',
      'video',
      'timeline',
    ]
    const nodes = kinds.map((kind, index) => ({
      id: `guide-${kind}`,
      kind,
      label: [
        '创作需求',
        '故事编剧',
        '分镜导演',
        '提示词助手',
        '图片生成',
        '镜头视频',
        '成片导出',
      ][index],
      position: {
        x: (index % 4) * 300 + 40,
        y: Math.floor(index / 4) * 300 + 100,
      },
      config: {
        text: '',
        providerId: ['story', 'storyboard', 'prompt'].includes(kind)
          ? provider.id
          : '',
        instructions: '',
        temperature: 0.4,
        shotCount: 3,
        duration: 12,
      },
      output: null,
      stale: false,
    }))
    nodes[0].config.text =
      '制作一部12秒的治愈系AI动漫短片《星光来信》。雨夜的城市屋顶，白发蓝眼、穿蓝色雨衣的少女邮差小星，给橘白小猫送来一封发光的信。信纸化成星光小伞，为小猫遮雨。要求角色一致，温暖结尾，恰好3个镜头，每个4秒。'
    nodes[1].config.instructions =
      '请写中文动漫剧本，包含明确的角色外观、动作、情绪和完整结尾。content 控制在300到500字，characters使用字符串数组。'
    nodes[2].config.instructions =
      '必须恰好3个镜头，每个duration为4，总时长12秒。保持白发蓝眼蓝雨衣少女与橘白小猫设定。每个镜头必须包含场景动作、对白、景别运镜、imagePrompt和videoPrompt。'
    nodes[3].config.instructions =
      '为这部作品整理统一动漫画风、角色一致性、光影和构图提示词，负面提示词排除角色漂移和画面文字。'
    const links = [
      ['brief', 'story'],
      ['story', 'storyboard'],
      ['storyboard', 'prompt'],
      ['storyboard', 'image'],
      ['image', 'video'],
      ['video', 'timeline'],
    ]
    const anime = {
      schemaVersion: 1,
      id: `guide-anime-${randomUUID()}`,
      name: '星光来信 · AI动漫创作演示',
      updatedAt: Date.now(),
      nodes,
      edges: links.map(([source, target]) => ({
        id: `${source}-${target}`,
        source: `guide-${source}`,
        target: `guide-${target}`,
      })),
      viewport: { x: 0, y: 0, zoom: 0.55 },
    }
    await app.invoke('save_workflow', { workflow: anime })
    await writeFile(
      path.join(directory, 'setup.json'),
      JSON.stringify(
        { profile, provider, animeId: anime.id, mediaId: media.id, bundlePath },
        null,
        2,
      ),
    )
    await writeFile(
      path.join(directory, '动漫工作流.json'),
      JSON.stringify(anime, null, 2),
    )
    await app.page.reload()
    const stop = await recordTutorialPage(
      app.page,
      path.join(directory, 'capture-preview.mp4'),
    )
    await app.page.getByRole('button', { name: '工作流', exact: true }).click()
    await wait(3)
    await stop()
    console.log(
      `Prepared isolated real-media tutorial project and capture preview: ${directory}`,
    )
  } finally {
    await app.close()
  }
}

try {
  if (mode === '--configure') {
    const app = await openTutorialApp(
      root,
      path.join(directory, 'configuration-webview'),
      null,
    )
    try {
      await configure(app.page)
      const providers = await app.invoke('list_providers')
      const provider = providers.find(
        (provider) => provider.name === 'Vectio · Grok 4.7',
      )
      await writeFile(
        path.join(directory, 'configured-provider.json'),
        JSON.stringify(
          {
            provider,
            configuredAt: new Date().toISOString(),
            catalog: 'passed',
            reply: 'passed',
            dataScope: 'normal desktop application',
          },
          null,
          2,
        ),
      )
      console.log(
        'PASS: Vectio Grok 4.7 saved in the normal desktop application; live catalog and actual reply passed.',
      )
    } finally {
      await app.close()
    }
  } else if (mode === '--prepare') await prepare()
  else throw new Error('Choose --configure or --prepare explicitly.')
} catch (error) {
  console.error(
    String(error).replaceAll(
      process.env.FRAME_STUDIO_LIVE_TEXT_KEY || 'UNSET_SECRET',
      '[REDACTED_SECRET]',
    ),
  )
  process.exitCode = 1
}
