/** Keep this contract aligned with src-tauri/src/commands/mod.rs. */
export interface AppInfo {
  name: string
  version: string
  platform: string
  architecture: string
}

export type RuntimeStatus =
  | { state: 'browser' }
  | { state: 'loading' }
  | { state: 'ready'; info: AppInfo }
  | { state: 'error'; message: string }
