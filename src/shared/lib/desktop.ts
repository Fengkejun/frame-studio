import { invoke, isTauri } from '@tauri-apps/api/core'
import type { AppInfo } from '@/shared/types/desktop'

export const isDesktop = isTauri()

/** Browser preview never fabricates a successful native connection. */
export async function getAppInfo(): Promise<AppInfo> {
  if (!isDesktop) throw new Error('请在桌面应用中检查原生连接。')

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      invoke<AppInfo>('get_app_info'),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('桌面连接超时，请重试。')),
          8000,
        )
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}
