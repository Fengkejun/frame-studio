import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from '@playwright/test'
import {
  openTutorialApp,
  recordTutorialPage,
  wait,
} from './tutorial-runtime.mjs'
import { tutorialChapters } from './user-tutorial-plan.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.resolve(
  process.env.FRAME_STUDIO_TUTORIAL_DIR ||
    path.join(root, 'artifacts/user-guide-2026-10-15'),
)
const setup = JSON.parse(
  await readFile(path.join(directory, 'setup.json'), 'utf8'),
)
const chapterDirectory = path.join(directory, 'chapters')
await mkdir(chapterDirectory, { recursive: true })
const exists = async (file) =>
  access(file).then(
    () => true,
    () => false,
  )
const probe = (file) =>
  JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
      { encoding: 'utf8', windowsHide: true },
    ),
  )
const chapters = tutorialChapters.map((chapter) => ({
  ...chapter,
  voicePath: path.join(
    chapterDirectory,
    `${chapter.id}-${createHash('sha256').update(chapter.text).digest('hex').slice(0, 8)}.wav`,
  ),
}))
await writeFile(
  path.join(directory, 'narration-plan.json'),
  JSON.stringify(chapters, null, 2),
)
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-File',
    path.join(root, 'scripts/tutorial-narration.ps1'),
    '-PlanPath',
    path.join(directory, 'narration-plan.json'),
  ],
  { windowsHide: true, stdio: 'inherit' },
)
const progressFile = path.join(directory, 'recording-progress.json')
const progress = (await exists(progressFile))
  ? JSON.parse(await readFile(progressFile, 'utf8'))
  : {}
const saveProgress = () =>
  writeFile(progressFile, JSON.stringify(progress, null, 2))
const bundleOutput = path.join(directory, '媒体演示项目-可导入.framepack')
await mkdir(path.join(directory, 'backups'), { recursive: true })
const app = await openTutorialApp(root, setup.profile, setup.profile, {
  FRAME_STUDIO_TEST_PROJECT_BUNDLE_PATH: bundleOutput,
  FRAME_STUDIO_TEST_EXPORT_PATH: path.join(directory, '录制示范导出.mp4'),
  FRAME_STUDIO_TEST_BACKUP_DIRECTORY: path.join(directory, 'backups'),
})
const { page, invoke } = app
let activeRecording
const pause = () => wait(3)
const click = async (name) => {
  await page.getByRole('button', { name, exact: true }).click()
  await pause()
}
const show = async (locator) => {
  await locator.first().scrollIntoViewIfNeeded()
  await pause()
}
const selectNode = async (kind) => {
  await page.getByTestId(`rf__node-guide-${kind}`).locator('.node-mark').click()
  await pause()
}
async function project(id, tab) {
  await page.getByRole('button', { name: '工作流', exact: true }).click()
  await page.getByLabel('切换工作流').selectOption(id)
  if (tab) await page.getByRole('button', { name: tab, exact: true }).click()
  await pause()
}

const scenes = {
  '01': async () => {
    await click('工作台')
    await show(page.locator('.setup-card'))
    await show(page.locator('.details-list'))
    await click('工作流')
    await page.getByLabel('切换工作流').selectOption(setup.animeId)
    await pause()
  },
  '02': async () => {
    await click('模型连接')
    await page
      .locator('.connection-item')
      .filter({ hasText: 'Vectio · Grok 4.7' })
      .click()
    await page.getByLabel('连接名称').fill('Vectio · Grok 4.7')
    await pause()
    await page.getByLabel('API 根地址').fill('https://vectio.cc/v1')
    await pause()
    await page.getByLabel('模型 ID', { exact: true }).fill('grok-4.7')
    await pause()
    const key = process.env.FRAME_STUDIO_LIVE_TEXT_KEY
    if (key) {
      await page.getByLabel('API Key', { exact: false }).fill(key)
      await pause()
    }
    await click('测试连接')
    await expect(page.getByText(/连接正常，已找到配置的模型/)).toBeVisible({
      timeout: 30000,
    })
    await click('测试模型回复')
    await expect(page.getByText(/模型回复验证通过/)).toBeVisible({
      timeout: 100000,
    })
  },
  '03': async () => {
    await click('模型连接')
    await click('＋ 新建')
    await page.getByLabel('连接名称').fill('本地 Ollama 示例（未保存）')
    await page.getByLabel('接入方式').selectOption('ollama')
    await page.getByLabel('模型 ID', { exact: true }).fill('qwen2.5-coder:7b')
    await show(
      page.getByRole('button', { name: '刷新已安装模型', exact: true }),
    )
    await show(
      page.getByRole('button', { name: '下载当前模型 ID', exact: true }),
    )
  },
  '04': async () => {
    await project(setup.animeId)
    await selectNode('brief')
    const brief = page.locator('.node-inspector textarea').first()
    const text = await brief.inputValue()
    await brief.fill(`${text}\n画风清新，角色外观保持一致。`)
    await pause()
    await click('撤销')
    await click('重做')
    await selectNode('story')
    await page.locator('.node-inspector select').selectOption(setup.provider.id)
    await selectNode('storyboard')
    await page.getByLabel('总时长 / 秒').fill('12')
    await page.getByLabel('镜头数量').fill('3')
    await show(page.getByLabel('Agent 任务要求'))
  },
  '05': async () => {
    await project(setup.animeId)
    if (!progress.runId) {
      const before = new Set(
        (await invoke('list_runs', { workflowId: setup.animeId })).map(
          (run) => run.id,
        ),
      )
      await click('▶ 运行工作流')
      await show(page.getByRole('dialog'))
      await click('开始执行')
      await expect
        .poll(async () => {
          const run = (
            await invoke('list_runs', { workflowId: setup.animeId })
          ).find((item) => !before.has(item.id))
          if (run) {
            progress.runId = run.id
            await saveProgress()
          }
          return !!run
        })
        .toBe(true)
    }
    let run
    await expect
      .poll(
        async () => {
          run = await invoke('get_run', { id: progress.runId })
          return run.status
        },
        { timeout: 420000, intervals: [1000, 3000] },
      )
      .not.toBe('running')
    await writeFile(
      path.join(directory, '真实动漫文本运行.json'),
      JSON.stringify(run, null, 2),
    )
    for (const kind of ['story', 'storyboard', 'prompt']) {
      const result = run.nodes.find((node) => node.nodeId === `guide-${kind}`)
      assert.equal(result?.status, 'succeeded', `${kind}: ${result?.message}`)
    }
    await selectNode('story')
    await show(page.locator('.node-inspector .output-preview'))
    await click('分镜故事板')
    await expect(page.locator('.storyboard-card')).toHaveCount(3)
  },
  '06': async () => {
    await project(setup.animeId, '分镜故事板')
    await show(page.locator('.storyboard-card'))
    await selectNode('storyboard')
    await show(page.locator('.node-inspector .output-preview'))
    await selectNode('prompt')
    await show(page.locator('.node-inspector .output-preview'))
    await page.getByRole('button', { name: /运行记录/ }).click()
    await show(page.locator('.run-history'))
  },
  '07': async () => {
    await project(setup.mediaId, '首帧与素材')
    await page.getByLabel('首帧目标镜头').selectOption({ index: 0 })
    await show(page.getByRole('heading', { name: '角色参考图', exact: true }))
    await page.getByLabel('角色名称', { exact: true }).fill('红纸船参考')
    await page.getByRole('button', { name: /本地素材库/ }).click()
    await show(page.locator('.asset-card'))
    await page
      .getByRole('button', { name: '绑定为角色参考图', exact: true })
      .first()
      .click()
    await show(page.getByRole('heading', { name: '角色参考图', exact: true }))
    await page
      .getByLabel('导入本地图片')
      .setInputFiles(path.join(root, 'artifacts/sd-reference-lake.jpg'))
    await show(page.locator('.asset-card'))
  },
  '08': async () => {
    await project(setup.mediaId, '首帧与素材')
    await click('云端生图')
    await page
      .getByLabel('云端图片 API 根地址')
      .fill('https://matrix.000328.xyz/v1')
    await page.getByLabel('云端图片模型').selectOption('gpt-image-2')
    await show(page.getByLabel('云端生图方式'))
    await show(page.getByLabel('云端图片画幅'))
    await page.getByText('批量生成镜头候选', { exact: true }).click()
    await pause()
    await click('本机 ComfyUI')
    await show(page.getByLabel('ComfyUI 工作流模式'))
    await page.getByLabel('ComfyUI 工作流模式').selectOption('flux')
    await pause()
    await page.getByLabel('ComfyUI 工作流模式').selectOption('custom')
    await show(page.getByLabel('导入 ComfyUI API 工作流 JSON'))
    await page.locator('.comfy-model-manager summary').click()
    await show(page.locator('.comfy-model-manager'))
  },
  '09': async () => {
    await project(setup.mediaId, '镜头视频')
    await page.getByLabel('视频服务', { exact: true }).selectOption('relay')
    await page.getByLabel('视频 API 根地址').fill('https://api.wulusai.com')
    await page
      .getByLabel('视频模型', { exact: true })
      .selectOption('sd2.0-mini')
    await page.getByLabel('视频生成方式').selectOption('frame')
    await page.getByLabel('视频时长').fill('4')
    await page.getByLabel('视频分辨率').selectOption('480P')
    await show(page.getByLabel('视频提示词'))
    await page.getByText('批量生成视频候选', { exact: true }).click()
    await pause()
    await page
      .getByRole('button', { name: '播放片段', exact: true })
      .first()
      .click()
    const video = page.getByLabel('镜头视频预览')
    await show(video)
    await expect
      .poll(() => video.evaluate((el) => el.readyState))
      .toBeGreaterThanOrEqual(2)
    await video.evaluate(async (el) => {
      el.muted = true
      await el.play()
    })
    await wait(5)
    await video.evaluate((el) => el.pause())
  },
  10: async () => {
    await project(setup.mediaId, '时间线与导出')
    await show(page.getByRole('heading', { name: '画面与声音', exact: true }))
    await page.getByLabel('配音起点', { exact: true }).fill('0.2')
    await show(page.getByRole('heading', { name: 'AI 配音生成', exact: true }))
    await page.locator('.speech-connection summary').click()
    await show(page.getByLabel('配音模型 ID'))
    await page.getByLabel('旁白文本').fill('湖面很安静，红色纸船轻轻漂过。')
    await show(page.getByRole('heading', { name: '配音自动字幕', exact: true }))
    await page.getByLabel('导入字幕文件').setInputFiles({
      name: '字幕示例.srt',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        '1\n00:00:00,000 --> 00:00:03,800\n湖面上的红纸船\n\n2\n00:00:03,800 --> 00:00:07,600\n缓缓靠近，涟漪轻漾\n\n3\n00:00:07,600 --> 00:00:11,600\n小小的旅程，继续向前\n',
      ),
    })
    await pause()
  },
  11: async () => {
    await project(setup.mediaId, '时间线与导出')
    await show(page.getByLabel('片段 1 开始'))
    await page.getByLabel('片段 1 字幕').fill('湖面上的红纸船')
    await page.getByLabel('导出画幅').selectOption('9:16')
    await pause()
    await page.getByLabel('导出画幅').selectOption('16:9')
    await page.getByLabel('导出分辨率').selectOption('720')
    await page.getByLabel('导出质量').selectOption('balanced')
    await show(
      page.getByRole('button', { name: '选择位置并导出 MP4', exact: true }),
    )
    await click('选择位置并导出 MP4')
    await expect(page.locator('.timeline-export').first()).toContainText(
      '已完成',
      { timeout: 120000 },
    )
    await page
      .getByRole('button', { name: '播放成片', exact: true })
      .first()
      .click()
    await pause()
    const video = page.getByLabel('成片播放器')
    await show(video)
    await expect
      .poll(() => video.evaluate((el) => el.readyState))
      .toBeGreaterThanOrEqual(2)
    await video.evaluate(async (el) => {
      el.muted = true
      await el.play()
    })
    await wait(12)
    await video.evaluate((el) => el.pause())
  },
  12: async () => {
    await project(setup.mediaId)
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出', exact: true }).click()
    await (await download).saveAs(path.join(directory, '媒体工作流.json'))
    if (!(await exists(bundleOutput))) {
      await click('导出项目包')
      await expect(page.locator('.save-state')).toContainText('项目包已保存', {
        timeout: 60000,
      })
    }
    await page.getByText('项目备份与恢复', { exact: true }).first().click()
    await click('选择备份位置')
    await click('备份当前项目')
    await show(page.getByLabel('备份记录'))
  },
  13: async () => {
    await click('设置')
    await page.getByRole('radio', { name: /浅色/ }).check()
    await pause()
    await page.getByRole('radio', { name: /深色/ }).check()
    await show(page.getByLabel('素材与存储'))
    await page.getByText(/清理预览 · 未引用候选/).click()
    await pause()
    await page.getByText(/回收区 ·/).click()
    await pause()
    await click('工作台')
  },
}

function time(seconds, separator = '.') {
  const ms = Math.max(0, Math.round(seconds * 1000))
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}`
}
function captions(text, duration) {
  const chunks = []
  for (const sentence of text.match(/[^。！？]+[。！？]?/g) || [text]) {
    const size = Math.ceil(sentence.length / Math.ceil(sentence.length / 38))
    for (let offset = 0; offset < sentence.length; offset += size)
      chunks.push(sentence.slice(offset, offset + size))
  }
  let offset = 0
  return chunks.map((text) => {
    const start = offset
    offset +=
      (duration * text.length) /
      chunks.reduce((total, text) => total + text.length, 0)
    return { start, end: offset, text }
  })
}
function assTime(seconds) {
  return time(seconds).replace(/^0/, '').slice(0, -1)
}
let stop
try {
  // A click marker is part of the tutorial overlay, never application state.
  await page.evaluate(() => {
    globalThis.window.addEventListener(
      'pointerdown',
      (event) => {
        const marker = globalThis.document.createElement('div')
        Object.assign(marker.style, {
          position: 'fixed',
          left: `${event.clientX - 15}px`,
          top: `${event.clientY - 15}px`,
          width: '30px',
          height: '30px',
          border: '3px solid #bde26d',
          borderRadius: '50%',
          pointerEvents: 'none',
          zIndex: '2147483647',
          boxShadow: '0 0 0 5px #bde26d33',
        })
        globalThis.document.body.append(marker)
        setTimeout(() => marker.remove(), 650)
      },
      true,
    )
  })
  for (const chapter of chapters) {
    const output = path.join(chapterDirectory, `${chapter.id}.mp4`)
    const rerecord = process.argv.includes(`--rerecord=${chapter.id}`)
    const refreshOverlay =
      process.argv.includes('--refresh-overlays') &&
      progress[chapter.id] &&
      !rerecord
    if (
      progress[chapter.id] &&
      (await exists(output)) &&
      !refreshOverlay &&
      !rerecord
    ) {
      console.log(`Keep completed chapter ${chapter.id}: ${chapter.title}`)
      continue
    }
    const raw = path.join(chapterDirectory, `${chapter.id}-raw.mp4`)
    const voiceDuration = Number(probe(chapter.voicePath).format.duration)
    if (refreshOverlay || process.argv.includes(`--reuse-raw=${chapter.id}`)) {
      assert.ok(await exists(raw), 'An existing native recording is required.')
      console.log(`Editing existing native recording ${chapter.id}`)
    } else {
      const began = Date.now()
      console.log(
        `Recording ${chapter.id}: ${chapter.title}; narration ${voiceDuration.toFixed(1)}s`,
      )
      activeRecording = await recordTutorialPage(page, raw)
      await scenes[chapter.id]()
      await wait(Math.max(0, voiceDuration + 2 - (Date.now() - began) / 1000))
      stop = activeRecording
      activeRecording = null
      await stop()
    }
    const sourceDuration = Number(probe(raw).format.duration)
    let source = raw
    const waitingAccelerated =
      chapter.id === '05' && sourceDuration > voiceDuration + 8
    if (waitingAccelerated) {
      // Keep submission and final results at normal speed; compress only waiting.
      const middleEnd = sourceDuration - 12
      const middleDuration = voiceDuration + 2 - 27
      const speed = middleDuration / (middleEnd - 15)
      source = path.join(chapterDirectory, `${chapter.id}-edited.mp4`)
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-y',
          '-i',
          raw,
          '-filter_complex',
          `[0:v]trim=0:15,setpts=PTS-STARTPTS[a];[0:v]trim=15:${middleEnd},setpts=${speed}*(PTS-STARTPTS)[b];[0:v]trim=start=${middleEnd},setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1:a=0,fps=30[v]`,
          '-map',
          '[v]',
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          '-threads',
          '2',
          source,
        ],
        { windowsHide: true },
      )
    }
    const duration = Number(probe(source).format.duration)
    const cues = captions(chapter.text, voiceDuration)
    const ass =
      '[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Microsoft YaHei,30,&H00FFFFFF,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,30,30,18,1\nStyle: Header,Microsoft YaHei,26,&H009FE1C9,&H00FFFFFF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,2,1,8,30,30,12,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
      `Dialogue: 1,0:00:00.00,${assTime(duration)},Header,,0,0,0,,第 ${Number(chapter.id)} 章  ${chapter.title}\n` +
      (waitingAccelerated
        ? `Dialogue: 1,0:00:15.00,${assTime(duration - 12)},Header,,0,0,58,,等待过程已加速\n`
        : '') +
      cues
        .map(
          (cue) =>
            `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${cue.text}`,
        )
        .join('\n')
    const assPath = path.join(chapterDirectory, `${chapter.id}.ass`)
    await writeFile(assPath, ass)
    execFileSync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-i',
        source,
        '-i',
        chapter.voicePath,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-vf',
        `ass=${chapter.id}.ass`,
        '-af',
        'apad',
        '-t',
        String(duration),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-threads',
        '2',
        '-c:a',
        'aac',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        output,
      ],
      { cwd: chapterDirectory, windowsHide: true },
    )
    progress[chapter.id] = {
      title: chapter.title,
      duration,
      file: output,
      voiceDuration,
      sourceDuration,
      waitingAccelerated,
      cues,
    }
    await saveProgress()
    console.log(`Finished chapter ${chapter.id}: ${duration.toFixed(1)}s`)
  }
  const animeRun = await invoke('get_run', { id: progress.runId })
  const anime = (await invoke('list_workflows')).find(
    (workflow) => workflow.id === setup.animeId,
  )
  assert.ok(anime, 'The generated anime workflow must still exist.')
  const outputFor = (kind) =>
    animeRun.nodes.find((node) => node.nodeId === `guide-${kind}`)?.output
      ?.value
  const story = outputFor('story')
  const storyboard = outputFor('storyboard')
  const prompt = outputFor('prompt')
  assert.ok(story && storyboard && prompt)
  assert.equal(storyboard.shots.length, 3)
  assert.equal(
    storyboard.shots.reduce((sum, shot) => sum + shot.duration, 0),
    12,
  )
  await writeFile(
    path.join(directory, '动漫工作流-含生成结果.json'),
    JSON.stringify(anime, null, 2),
  )
  const script = [
    `# ${story.title}`,
    '',
    '> 真实 Grok 4.7 文本输出；对应动漫图片与视频尚未生成。',
    '',
    '## 故事梗概',
    '',
    story.logline,
    '',
    '## 角色',
    '',
    ...story.characters.map((character) => `- ${character}`),
    '',
    '## 完整剧本',
    '',
    story.content,
    '',
    '## 分镜',
    '',
    ...storyboard.shots.flatMap((shot, index) => [
      `### ${index + 1}. ${shot.title}（${shot.duration} 秒）`,
      '',
      shot.description,
      '',
      `角色：${shot.characters.join('、')}`,
      '',
      `对白：${shot.dialogue || '无'}`,
      '',
      `运镜：${shot.camera}`,
      '',
      `图片提示词：${shot.imagePrompt}`,
      '',
      `视频提示词：${shot.videoPrompt}`,
      '',
    ]),
    '## 统一提示词',
    '',
    prompt.text,
    '',
    `避免元素：${prompt.negativePrompt}`,
    '',
  ]
  await writeFile(
    path.join(directory, '星光来信-剧本与分镜.md'),
    script.join('\n'),
  )
  const list = chapters.map((chapter) => `file '${chapter.id}.mp4'`).join('\n')
  await writeFile(path.join(chapterDirectory, 'concat.txt'), list)
  const output = path.join(directory, 'Frame-Studio-完整使用教程.mp4')
  execFileSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      'concat.txt',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      output,
    ],
    { cwd: chapterDirectory, windowsHide: true },
  )
  let offset = 0
  let cueIndex = 0
  const srt = []
  const index = [
    '# Frame Studio 完整使用教程',
    '',
    '实际桌面录制，中文合成配音。云端文本为本轮真实 Grok 4.7 调用；媒体章节复用此前真实 SD 视频，语音和转写服务展示配置入口。',
    '',
  ]
  for (const chapter of chapters) {
    const entry = progress[chapter.id]
    index.push(`- ${time(offset).slice(0, 8)} ${chapter.title}`)
    for (const cue of entry.cues)
      srt.push(
        `${++cueIndex}\n${time(offset + cue.start, ',')} --> ${time(offset + cue.end, ',')}\n${cue.text}\n`,
      )
    offset += entry.duration
  }
  await writeFile(path.join(directory, '完整使用教程.srt'), srt.join('\n'))
  await writeFile(path.join(directory, '章节索引.md'), index.join('\n'))
  const actual = probe(output)
  assert.equal(
    actual.streams.find((stream) => stream.codec_type === 'video').width,
    1920,
  )
  assert.equal(
    actual.streams.find((stream) => stream.codec_type === 'audio').codec_name,
    'aac',
  )
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-xerror', '-i', output, '-f', 'null', '-'],
    { windowsHide: true },
  )
  await writeFile(
    path.join(directory, 'video-verification.json'),
    JSON.stringify(
      {
        file: output,
        probe: actual,
        chapters: progress,
        fullDecode: 'passed',
        textSource: 'live Vectio grok-4.7',
        mediaSource: 'previous real SD generation',
        narration: 'Windows Chinese speech synthesis',
        recordedInterface: 'native Tauri WebView2',
        secretDisplay: 'password inputs only',
      },
      null,
      2,
    ),
  )
  console.log(`PASS: verified complete tutorial ${output}`)
} catch (error) {
  await page
    .screenshot({ path: path.join(directory, 'recording-error.png') })
    .catch(() => {})
  console.error(
    String(error).replaceAll(
      process.env.FRAME_STUDIO_LIVE_TEXT_KEY || 'UNSET_SECRET',
      '[REDACTED_SECRET]',
    ),
  )
  process.exitCode = 1
} finally {
  await activeRecording?.().catch(() => {})
  await app.close()
}
