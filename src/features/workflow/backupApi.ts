import { invoke } from '@tauri-apps/api/core'
import { parseWorkflow, type Workflow } from './model'

export interface BackupPoint {
  id: string
  workflowId: string
  projectName: string
  createdAt: number
  fileCount: number
  totalBytes: number
  newBytes: number
  reusedBytes: number
}
export interface BackupReport {
  directory: string | null
  points: BackupPoint[]
  warnings: string[]
}
export const listBackups = (): Promise<BackupReport> =>
  invoke('list_project_backups')
export const chooseBackupDirectory = (): Promise<string | null> =>
  invoke('choose_backup_directory')
export const createBackup = (workflowId: string): Promise<BackupPoint> =>
  invoke('create_project_backup', { workflowId })
export async function restoreBackup(backupId: string): Promise<Workflow> {
  const workflow = await invoke<Workflow>('restore_project_backup', {
    backupId,
  })
  return parseWorkflow(JSON.stringify(workflow))
}
