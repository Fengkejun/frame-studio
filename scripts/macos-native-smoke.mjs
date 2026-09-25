import { execFileSync, spawn } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

if (process.platform !== 'darwin') {
  throw new Error('This native smoke test requires macOS.')
}

const app = path.resolve(
  process.argv[2] ?? 'src-tauri/target/debug/bundle/macos/Frame Studio.app',
)
const contents = path.join(app, 'Contents')
const plist = path.join(contents, 'Info.plist')
const executableName = execFileSync(
  'plutil',
  ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist],
  { encoding: 'utf8' },
).trim()
const executable = path.join(contents, 'MacOS', executableName)
const ffmpeg = path.join(contents, 'MacOS', 'ffmpeg')
const ffprobe = path.join(contents, 'MacOS', 'ffprobe')
const license = path.join(
  contents,
  'Resources',
  'binaries',
  'LICENSE-FFMPEG.txt',
)
const notice = path.join(contents, 'Resources', 'binaries', 'README-FFMPEG.txt')

await Promise.all(
  [app, plist, executable, ffmpeg, ffprobe, license, notice].map((item) =>
    access(item),
  ),
)

const identifier = execFileSync(
  'plutil',
  ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist],
  { encoding: 'utf8' },
).trim()
if (identifier !== 'com.frame-studio.desktop') {
  throw new Error(`Unexpected bundle identifier: ${identifier}`)
}

const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], {
  encoding: 'utf8',
  maxBuffer: 2 * 1024 * 1024,
})
const filters = execFileSync(ffmpeg, ['-hide_banner', '-filters'], {
  encoding: 'utf8',
  maxBuffer: 2 * 1024 * 1024,
})
if (!encoders.includes('libx264') || !encoders.includes('aac')) {
  throw new Error('Bundled FFmpeg is missing libx264 or AAC encoding.')
}
if (!/\bsubtitles\b/.test(filters)) {
  throw new Error('Bundled FFmpeg is missing the subtitles filter.')
}
execFileSync(ffprobe, ['-version'], { stdio: 'ignore' })

for (const binary of [ffmpeg, ffprobe]) {
  const linked = execFileSync('otool', ['-L', binary], {
    encoding: 'utf8',
  })
  const external = linked
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' (')[0])
    .filter(
      (item) =>
        item &&
        !item.startsWith('/usr/lib/') &&
        !item.startsWith('/System/Library/'),
    )
  if (external.length) {
    throw new Error(
      `${path.basename(binary)} has unbundled libraries: ${external.join(', ')}`,
    )
  }
}

const profile = await mkdtemp(path.join(os.tmpdir(), 'frame-studio-macos-'))
const child = spawn(executable, [], {
  env: {
    ...process.env,
    FRAME_STUDIO_TEST_DATA_DIR: profile,
    RUST_BACKTRACE: '1',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let stderr = ''
child.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-8000)
})

try {
  await Promise.race([
    delay(5000),
    new Promise((_, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        reject(
          new Error(
            `Native app exited before the smoke window elapsed (${code ?? signal}): ${stderr}`,
          ),
        )
      })
    }),
  ])
  await access(path.join(profile, 'studio.sqlite'))
  console.log(
    `PASS: ${path.basename(app)} launched with isolated storage and validated bundled FFmpeg/FFprobe.`,
  )
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(3000).then(() => child.kill('SIGKILL')),
    ])
  }
  await rm(profile, { recursive: true, force: true })
}
