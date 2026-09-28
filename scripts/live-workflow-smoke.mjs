import { setTimeout as delay } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'

// Optional native IPC run against the user's local Ollama and/or text gateway.
export async function testLiveWorkflow(page) {
  if (process.env.FRAME_STUDIO_LIVE_WORKFLOW !== '1') return

  const invoke = (command, args) =>
    page.evaluate(
      async ({ command, args }) => {
        const tauri = globalThis.__TAURI_INTERNALS__
        if (!tauri?.invoke) throw new Error('Tauri IPC is unavailable')
        return tauri.invoke(command, args)
      },
      { command, args },
    )

  const providers = []
  if (process.env.FRAME_STUDIO_LIVE_WORKFLOW_SKIP_LOCAL !== '1') {
    providers.push({
      label: 'Ollama qwen2.5-coder:7b',
      kind: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/api',
      model: 'qwen2.5-coder:7b',
      key: null,
    })
  }
  if (process.env.FRAME_STUDIO_LIVE_TEXT_BASE_URL) {
    if (!process.env.FRAME_STUDIO_LIVE_TEXT_KEY) {
      throw new Error(
        'The live text gateway key is required with its base URL.',
      )
    }
    providers.push({
      label: 'cloud text',
      kind: 'openai',
      baseUrl: process.env.FRAME_STUDIO_LIVE_TEXT_BASE_URL,
      model: process.env.FRAME_STUDIO_LIVE_TEXT_MODEL || 'gpt-5.6-sol',
      key: process.env.FRAME_STUDIO_LIVE_TEXT_KEY,
    })
  }

  for (const [index, provider] of providers.entries()) {
    const providerId = `live-provider-${index}-${Date.now()}`
    const workflowId = `live-workflow-${index}-${Date.now()}`
    const config = (providerId, text = '') => ({
      text,
      providerId,
      instructions: '一个温暖的雨夜书店短片，恰好一个 5 秒镜头。',
      temperature: 0.3,
      shotCount: 1,
      duration: 5,
    })
    const workflow = {
      schemaVersion: 1,
      id: workflowId,
      name: `真实文本验证 ${provider.label}`,
      viewport: { x: 0, y: 0, zoom: 1 },
      updatedAt: Date.now(),
      nodes: [
        {
          id: 'brief',
          kind: 'brief',
          label: '创作需求',
          position: { x: 0, y: 0 },
          config: config('', '雨夜，一只小猫在书店门口遇见愿意收留它的人。'),
          output: null,
          stale: false,
        },
        {
          id: 'story',
          kind: 'story',
          label: '故事编剧',
          position: { x: 350, y: 0 },
          config: config(providerId),
          output: null,
          stale: false,
        },
        {
          id: 'storyboard',
          kind: 'storyboard',
          label: '分镜导演',
          position: { x: 700, y: 0 },
          config: config(providerId),
          output: null,
          stale: false,
        },
      ],
      edges: [
        { id: 'brief-story', source: 'brief', target: 'story' },
        { id: 'story-board', source: 'story', target: 'storyboard' },
      ],
    }
    await invoke('save_provider', {
      provider: {
        id: providerId,
        name: provider.label,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        model: provider.model,
        hasKey: false,
      },
      apiKey: provider.key,
      clearKey: false,
    })
    try {
      const connection = await invoke('test_provider', { id: providerId })
      if (!connection.includes('已找到配置的模型')) {
        throw new Error(`${provider.label}: ${connection}`)
      }
      const started = await invoke('start_run', { workflow, target: null })
      const deadline = Date.now() + 420000
      let run
      while (Date.now() < deadline) {
        run = await invoke('get_run', { id: started.id })
        if (run.status !== 'running') break
        await delay(1500)
      }
      if (run?.status !== 'succeeded') {
        const details = run?.nodes
          ?.filter((node) => node.status === 'failed')
          .map((node) => `${node.nodeId}: ${node.message}`)
          .join('; ')
        throw new Error(
          `${provider.label}: run ${run?.status ?? 'timeout'} ${details}`,
        )
      }
      const story = run.nodes.find((node) => node.nodeId === 'story')?.output
        ?.value
      const shots = run.nodes.find((node) => node.nodeId === 'storyboard')
        ?.output?.value?.shots
      if (!story?.title || shots?.length !== 1 || shots[0].duration !== 5) {
        throw new Error(`${provider.label}: saved output mismatch`)
      }
      console.log(`PASS: native ${provider.label} brief → story → storyboard`)
    } finally {
      await invoke('remove_provider', { id: providerId }).catch(() => {
        if (provider.key && process.platform === 'win32') {
          try {
            execFileSync('cmdkey', [
              `/delete:${providerId}.com.frame-studio.desktop.models`,
            ])
            return
          } catch {
            /* The credential may already be gone. */
          }
        }
        console.warn('Live text test credential cleanup needs manual review.')
      })
    }
  }
}
