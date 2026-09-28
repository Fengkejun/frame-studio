// Opt-in protocol check for the local Ollama model and an OpenAI-compatible text gateway.
// Keys are read from the process environment and never printed or stored.
const cloudBase = process.env.FRAME_STUDIO_LIVE_TEXT_BASE_URL
const cloudKey = process.env.FRAME_STUDIO_LIVE_TEXT_KEY
const cloudModel = process.env.FRAME_STUDIO_LIVE_TEXT_MODEL || 'gpt-5.6-sol'
const localBase = 'http://127.0.0.1:11434/api'
const localModel = 'qwen2.5-coder:7b'

const schemas = {
  story:
    '{"title":"故事标题","logline":"一句话梗概","content":"完整故事脚本，包含起承转合和结尾","characters":["角色名称与外观设定"]}',
  storyboard:
    '{"shots":[{"id":"shot-01","title":"镜头标题","description":"场景与人物动作","duration":5,"characters":["角色名称"],"dialogue":"台词，可为空","camera":"景别与运镜","imagePrompt":"用于生成该镜头首帧的提示词","videoPrompt":"动作、运镜与时间变化的提示词"}]}',
}

const storyboardFormat = {
  type: 'object',
  properties: {
    shots: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          duration: { type: 'number', const: 5 },
          characters: { type: 'array', items: { type: 'string' } },
          dialogue: { type: 'string' },
          camera: { type: 'string' },
          imagePrompt: { type: 'string' },
          videoPrompt: { type: 'string' },
        },
        required: [
          'id',
          'title',
          'description',
          'duration',
          'characters',
          'dialogue',
          'camera',
          'imagePrompt',
          'videoPrompt',
        ],
      },
    },
  },
  required: ['shots'],
}
const storyFormat = {
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1 },
    logline: { type: 'string', minLength: 1 },
    content: { type: 'string', minLength: 1 },
    characters: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'logline', 'content', 'characters'],
}

function systemPrompt(kind) {
  return `你是专业的短视频创作助手。只输出一个 JSON 对象，不要 Markdown 代码围栏。使用中文。严格遵循此结构：${schemas[kind]}\n目标总时长 5 秒。如生成分镜，必须恰好 1 个镜头，镜头 ID 不重复，时长总和等于目标时长。\n用户定义的任务要求：写一个雨夜书店门口小猫寻找归宿的温暖短片。`
}

async function generate(base, model, key, kind, input, ollama) {
  const messages = [
    { role: 'system', content: systemPrompt(kind) },
    { role: 'user', content: JSON.stringify(input) },
  ]
  const body = ollama
    ? {
        model,
        messages,
        stream: false,
        format: kind === 'storyboard' ? storyboardFormat : storyFormat,
        options: { temperature: 0.3 },
      }
    : { model, messages, stream: false, temperature: 0.3 }
  const response = await fetch(
    `${base}/${ollama ? 'chat' : 'chat/completions'}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    },
  )
  if (!response.ok) throw new Error(`${kind} HTTP ${response.status}`)
  const data = await response.json()
  const content = ollama
    ? data.message?.content
    : data.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new Error(`${kind} missing content`)
  const clean = content
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/\s*```$/, '')
  return JSON.parse(clean)
}

async function testProvider(label, base, model, key, ollama) {
  const story = process.env.FRAME_STUDIO_LIVE_TEXT_STORYBOARD_ONLY
    ? {
        title: '雨夜书店',
        logline: '小猫找到归宿',
        content: '雨夜，一只小猫在书店门口遇见愿意收留它的人。',
        characters: ['小猫'],
      }
    : await generate(
        base,
        model,
        key,
        'story',
        { text: '5 秒温暖短片：雨夜，一只小猫在书店门口遇见愿意收留它的人。' },
        ollama,
      )
  if (
    !['title', 'logline', 'content'].every(
      (field) => typeof story[field] === 'string' && story[field].trim(),
    ) ||
    !Array.isArray(story.characters) ||
    !story.characters.every((name) => typeof name === 'string')
  ) {
    throw new Error(`${label}: story shape invalid`)
  }
  const storyboard = await generate(
    base,
    model,
    key,
    'storyboard',
    story,
    ollama,
  )
  const shots = storyboard.shots
  const shot = shots?.[0]
  if (
    !Array.isArray(shots) ||
    shots.length !== 1 ||
    shot?.duration !== 5 ||
    ![
      'id',
      'title',
      'description',
      'camera',
      'imagePrompt',
      'videoPrompt',
    ].every(
      (field) => typeof shot?.[field] === 'string' && shot[field].trim(),
    ) ||
    typeof shot?.dialogue !== 'string' ||
    !Array.isArray(shot?.characters) ||
    !shot.characters.every((name) => typeof name === 'string')
  ) {
    throw new Error(
      `${label}: storyboard shape or duration invalid (${JSON.stringify({
        count: Array.isArray(shots) ? shots.length : null,
        duration: shots?.[0]?.duration,
        keys: shots?.[0] ? Object.keys(shots[0]) : [],
      })})`,
    )
  }
  console.log(`PASS: ${label} story and one-shot storyboard JSON`)
}

const failures = []
if (process.env.FRAME_STUDIO_LIVE_TEXT_SKIP_LOCAL !== '1') {
  await testProvider(
    'Ollama qwen2.5-coder:7b',
    localBase,
    localModel,
    '',
    true,
  ).catch((error) => {
    console.error(error.message)
    failures.push(error)
  })
}
if (cloudBase || cloudKey) {
  if (!cloudBase || !cloudKey) {
    throw new Error('Set both live text base URL and key for the cloud test.')
  }
  await testProvider(
    'cloud text',
    cloudBase,
    cloudModel,
    cloudKey,
    false,
  ).catch((error) => {
    console.error(error.message)
    failures.push(error)
  })
}
if (failures.length) process.exitCode = 1
