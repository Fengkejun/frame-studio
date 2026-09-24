import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const triple = execFileSync('rustc', ['--print', 'host-tuple'], {
  encoding: 'utf8',
}).trim()
const extension = process.platform === 'win32' ? '.exe' : ''
const directory = path.join(root, 'src-tauri/binaries')
await mkdir(directory, { recursive: true })
let releaseDirectory
let encoderBinary
for (const name of ['ffmpeg', 'ffprobe']) {
  const command = `${name}${extension}`
  const source = process.env.FRAME_STUDIO_FFMPEG_DIR
    ? path.join(process.env.FRAME_STUDIO_FFMPEG_DIR, command)
    : execFileSync(
        process.platform === 'win32' ? 'where.exe' : 'which',
        [command],
        {
          encoding: 'utf8',
        },
      )
        .trim()
        .split(/\r?\n/)[0]
  const resolved = await realpath(source)
  const candidateRelease = path.resolve(path.dirname(resolved), '..')
  if (releaseDirectory && releaseDirectory !== candidateRelease) {
    throw new Error(
      'FFmpeg and FFprobe must come from the same release directory',
    )
  }
  releaseDirectory = candidateRelease
  if (name === 'ffmpeg') encoderBinary = resolved
  const target = path.join(directory, `${name}-${triple}${extension}`)
  await copyFile(resolved, target)
  const size = (await stat(target)).size
  console.log(`Prepared ${name} sidecar for ${triple}: ${size} bytes`)
}
const encoders = execFileSync(encoderBinary, ['-hide_banner', '-encoders'], {
  encoding: 'utf8',
  maxBuffer: 2 * 1024 * 1024,
})
const filters = execFileSync(encoderBinary, ['-hide_banner', '-filters'], {
  encoding: 'utf8',
  maxBuffer: 2 * 1024 * 1024,
})
if (
  !encoders.includes('libx264') ||
  !encoders.includes('aac') ||
  !/\bsubtitles\b/.test(filters)
) {
  throw new Error('FFmpeg build needs libx264, AAC and the subtitles filter')
}
const license =
  process.env.FRAME_STUDIO_FFMPEG_LICENSE ??
  path.join(releaseDirectory, 'LICENSE')
await copyFile(license, path.join(directory, 'LICENSE-FFMPEG.txt'))
const readme =
  process.env.FRAME_STUDIO_FFMPEG_README ??
  path.join(releaseDirectory, 'README.txt')
await copyFile(readme, path.join(directory, 'README-FFMPEG.txt'))
