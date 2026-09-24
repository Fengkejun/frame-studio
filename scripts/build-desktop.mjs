import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const bundle = { win32: 'nsis', darwin: 'dmg' }[process.platform]
if (!bundle)
  throw new Error('Desktop installers currently support Windows and macOS')

execFileSync(process.execPath, ['scripts/prepare-ffmpeg-sidecars.mjs'], {
  cwd: root,
  stdio: 'inherit',
})
const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
execFileSync(
  process.execPath,
  [
    cli,
    'build',
    '--config',
    'src-tauri/tauri.sidecar.conf.json',
    '--bundles',
    bundle,
  ],
  {
    cwd: root,
    stdio: 'inherit',
  },
)
