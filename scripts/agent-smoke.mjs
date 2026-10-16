import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'
import { createVideoRelayFixture } from './video-relay-smoke.mjs'
import { createCloudFixture } from './cloud-media-smoke.mjs'

export async function createAgentFixture(root) {
  const relay = await createVideoRelayFixture(root)
  const normalClip = execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=128x128:r=24:d=12',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=12',
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
  relay.setClip(normalClip)
  const cloud = await createCloudFixture(root)
  const requests = []
  let useImage = false
  const server = createServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end()
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const request = JSON.parse(raw)
    requests.push(request)
    const system = request.messages[0].content
    const content = request.messages[1].content
    const input = JSON.parse(
      Array.isArray(content)
        ? content.find((c) => c.type === 'text').text
        : content,
    )
    let result
    if (system.includes('storyDuration')) {
      const frame = !!input.referenceImage || useImage
      result = {
        title: '星光来信 · Agent 验证',
        summary: '自动编剧，编排三镜头，制作连续短片。',
        storyDuration: 12,
        duration: 12,
        shotCount: 3,
        production: {
          style: '二维日系动漫',
          characters: '白发蓝衣邮差与橘白猫',
          scene: '同一雨夜屋顶',
          rules: '人物服装和天气固定，动作连续',
        },
        steps: [
          'write_story',
          'write_storyboard',
          ...(frame && !input.referenceImage ? ['generate_image'] : []),
          ...(input.scriptOnly ? [] : ['generate_video']),
        ],
        skillIds: [
          'anime-story',
          'character-continuity',
          'cinematic-storyboard',
        ],
        skillSearchQuery: '',
        generationMode: frame ? 'frame' : 'text',
      }
    } else if (system.includes('imagePrompt'))
      result = {
        shots: [1, 2, 3].map((i) => ({
          id: `shot-${i}`,
          title: `连续镜头 ${i}`,
          description: '小星在雨夜屋顶将发光信递给小猫。',
          duration: 4,
          characters: ['小星', '小猫'],
          dialogue: i === 2 ? '这封信是给你的。' : '',
          camera: '平稳推进',
          imagePrompt: '白发蓝衣小星与同一只橘白猫，雨夜屋顶，二维动漫。',
          videoPrompt: `第${i}个动作承接上一镜头，信化为星光小伞，保持角色和雨夜不变。`,
        })),
      }
    else
      result = {
        title: '星光来信',
        logline: '一封信照亮雨夜。',
        content:
          '雨夜，小星抱着发光的信走近屋顶的小猫。她蹲下递信，信化成星光小伞，小猫安心地蹭她的手。',
        characters: ['小星：白发蓝眼，蓝雨衣', '同一只橘白短毛猫'],
      }
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(result) } }],
      }),
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    restoreClip: () => relay.setClip(normalClip),
    requests,
    relay,
    cloud,
    setUseImage: (value) => {
      useImage = value
    },
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      await relay.close()
      await cloud.close()
    },
  }
}
export async function testAgent(page, root, profile, fixture) {
  const invoke = (command, args = {}) =>
    page.evaluate(
      ({ command, args }) =>
        globalThis.__TAURI_INTERNALS__.invoke(command, args),
      { command, args },
    )
  const provider = {
    id: `agent-provider-${Date.now()}`,
    name: 'Agent 本地验证模型',
    kind: 'openai',
    baseUrl: fixture.url,
    model: 'fixture-director',
    hasKey: false,
  }
  await invoke('save_provider', { provider, apiKey: null, clearKey: false })
  await invoke('save_wulusai_video_key', {
    baseUrl: fixture.relay.baseUrl,
    apiKey: 'agent-fixture-video-key',
  })
  const config = {
    providerId: provider.id,
    video: {
      region: 'singapore',
      resolution: '480P',
      wulusai: {
        baseUrl: fixture.relay.baseUrl,
        model: 'minimax-h3',
        mode: 'text',
        ratio: null,
        budgetReservationMicroUsd: 500000,
      },
    },
    image: null,
    budgetMicroUsd: 1000000,
    autoSearchSkills: false,
  }
  await invoke('save_agent_config', { config })
  const skills = await invoke('list_agent_skills')
  expect(skills).toHaveLength(3)
  expect(
    await readFile(
      path.join(profile, 'agent/skills/anime-story/SKILL.md'),
      'utf8',
    ),
  ).toContain('动漫编剧')
  await page.reload()
  await expect(
    page.getByRole('heading', { name: '告诉我，你想讲一个怎样的故事？' }),
  ).toBeVisible()
  await page.getByRole('button', { name: '技能库', exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: 'Agent 技能库' }),
  ).toContainText('角色与场景连续性')
  await page.getByRole('button', { name: '完成', exact: true }).click()
  fixture.relay.setMode('hold')
  await page
    .getByLabel('告诉 Agent 你的创作需求')
    .fill('创作12秒雨夜邮差与小猫的治愈动漫，自动完成剧本、分镜和视频。')
  await page
    .getByRole('button', { name: '开始自动制作 ↑', exact: true })
    .click()
  let first
  await expect
    .poll(
      async () => {
        first = (await invoke('list_agent_sessions'))[0]
        return first?.videoJobId
      },
      { timeout: 15000 },
    )
    .toBeTruthy()
  const duplicate = await invoke('start_agent', {
    request: first.request,
  }).then(() => '', String)
  expect(duplicate).toContain('已有 Agent')
  const activeProject = (await invoke('list_workflows')).find(
    (w) => w.id === first.workflowId,
  )
  const editBlocked = await invoke('save_workflow', {
    workflow: activeProject,
  }).then(() => '', String)
  expect(editBlocked).toContain('Agent 正在制作')
  await page.reload()
  await expect(page.locator('.agent-plan')).toContainText('自动编剧')
  fixture.relay.setMode('success')
  await expect
    .poll(
      async () => {
        first = await invoke('get_agent_session', { id: first.id })
        return first.status
      },
      { timeout: 25000 },
    )
    .toBe('succeeded')
  expect(fixture.requests).toHaveLength(3)
  expect(fixture.relay.requests).toHaveLength(1)
  expect(fixture.relay.requests[0].payload.duration).toBe(12)
  expect(fixture.relay.requests[0].payload.content[0].text).toContain(
    '白发蓝衣邮差',
  )
  expect(JSON.parse(fixture.requests[1].messages[1].content).skills).toContain(
    '角色与场景连续性',
  )
  expect(
    first.events.filter((e) => e.status === 'succeeded').map((e) => e.tool),
  ).toEqual(
    expect.arrayContaining([
      'plan',
      'load_skills',
      'write_story',
      'write_storyboard',
      'generate_video',
      'deliver',
    ]),
  )
  expect((await stat(first.outputPath)).size).toBeGreaterThan(100)
  await expect(page.getByLabel('Agent 生成视频')).toBeVisible()
  await expect
    .poll(() => page.getByLabel('Agent 生成视频').evaluate((v) => v.readyState))
    .toBeGreaterThan(0)
  await page.screenshot({ path: path.join(profile, 'agent-success.png') })
  // Follow-up uses the previous project's real script and preserves its versions.
  await page.getByLabel('Agent 创作模式').selectOption('script')
  await page
    .getByLabel('告诉 Agent 你的创作需求')
    .fill('把结尾改成小猫主动回信，先只改剧本与分镜。')
  await page.getByRole('button', { name: '开始创作剧本', exact: true }).click()
  let next
  await expect
    .poll(
      async () => {
        next = (await invoke('list_agent_sessions'))[0]
        return next.id !== first.id ? next.status : ''
      },
      { timeout: 15000 },
    )
    .toBe('succeeded')
  expect(next.request.parentId).toBe(first.id)
  expect(fixture.relay.requests).toHaveLength(1)
  expect(
    JSON.parse(fixture.requests[3].messages[1].content).previous.workflow
      .nodes[1].output.value.title,
  ).toBe('星光来信')
  expect(
    (await invoke('get_agent_session', { id: first.id })).videoVersionId,
  ).toBe(first.videoVersionId)
  // Reference image is sent to the director as vision input and to the video as its first frame.
  const image = await invoke('import_image', {
    name: 'reference.png',
    bytes: [
      ...(await readFile(path.join(root, 'src-tauri/icons/128x128@2x.png'))),
    ],
  })
  const frameConfig = structuredClone(config)
  frameConfig.video.wulusai.model = 'grok-imagine-video-1.5-lite'
  const framed = await invoke('start_agent', {
    request: {
      goal: '使用图中角色做连续动漫。',
      config: frameConfig,
      referenceVersionId: image.versionId,
      parentId: null,
      scriptOnly: false,
    },
  })
  let framedResult
  await expect
    .poll(
      async () => {
        framedResult = await invoke('get_agent_session', { id: framed.id })
        return framedResult.status
      },
      { timeout: 25000 },
    )
    .toBe('succeeded')
  expect(fixture.requests[6].messages[1].content[1].image_url.url).toMatch(
    /^data:image\/png;base64,/,
  )
  expect(fixture.relay.requests).toHaveLength(2)
  expect(fixture.relay.requests[1].payload.input_reference).toMatch(
    /^data:image\/jpeg;base64,/,
  )
  // With a configured image tool and no uploaded reference, the Agent creates and binds a first frame automatically.
  fixture.cloud.setImage(
    await readFile(path.join(root, 'src-tauri/icons/128x128@2x.png')),
  )
  await invoke('save_cloud_image_key', {
    baseUrl: fixture.cloud.baseUrl,
    apiKey: 'agent-fixture-image-key',
  })
  fixture.setUseImage(true)
  const generated = await invoke('start_agent', {
    request: {
      ...first.request,
      config: {
        ...frameConfig,
        image: {
          baseUrl: fixture.cloud.baseUrl,
          model: 'gpt-image-2',
          size: '1536x1024',
          quality: 'low',
          budgetReservationMicroUsd: 250000,
        },
      },
    },
  })
  let generatedResult
  await expect
    .poll(
      async () => {
        generatedResult = await invoke('get_agent_session', {
          id: generated.id,
        })
        return generatedResult.status
      },
      { timeout: 25000 },
    )
    .toBe('succeeded')
  expect(generatedResult.referenceVersionId).toBeTruthy()
  expect(fixture.cloud.requests).toHaveLength(1)
  expect(fixture.relay.requests).toHaveLength(3)
  expect(generatedResult.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ tool: 'generate_image', status: 'succeeded' }),
    ]),
  )
  fixture.setUseImage(false)
  // Insufficient total budget is rejected before any media POST.
  const low = await invoke('start_agent', {
    request: { ...first.request, config: { ...config, budgetMicroUsd: 10000 } },
  })
  let stopped
  await expect
    .poll(
      async () => {
        stopped = await invoke('get_agent_session', { id: low.id })
        return stopped.status
      },
      { timeout: 15000 },
    )
    .toBe('paused')
  expect(stopped.message).toContain('预算')
  expect(fixture.relay.requests).toHaveLength(3)
  // Unknown submission is never resubmitted by recovery.
  fixture.relay.setMode('lost')
  const lost = await invoke('start_agent', { request: first.request })
  await expect
    .poll(
      async () => {
        stopped = await invoke('get_agent_session', { id: lost.id })
        return stopped.status
      },
      { timeout: 15000 },
    )
    .toBe('paused')
  expect(fixture.relay.requests).toHaveLength(4)
  await invoke('resume_agent', { id: lost.id })
  await expect
    .poll(
      async () => (await invoke('get_agent_session', { id: lost.id })).status,
      { timeout: 15000 },
    )
    .toBe('paused')
  expect(fixture.relay.requests).toHaveLength(4)
  fixture.relay.setMode('success')
  fixture.relay.setClip(
    await readFile(path.join(root, 'tests/fixtures/clip.mp4')),
  )
  const short = await invoke('start_agent', { request: first.request })
  await expect
    .poll(
      async () => {
        stopped = await invoke('get_agent_session', { id: short.id })
        return stopped.status
      },
      { timeout: 25000 },
    )
    .toBe('paused')
  expect(stopped.message).toContain('实际时长')
  expect(stopped.videoVersionId).toBeTruthy()
  expect(fixture.relay.requests).toHaveLength(5)
  fixture.restoreClip()
  console.log(
    'PASS: real native Agent planning, installed skill loading, script/storyboard/video tools, page-reload continuity, local delivery/playback, follow-up context, vision reference, budget preflight and no resubmit after an unknown result. Local model/media fixtures only.',
  )
}
