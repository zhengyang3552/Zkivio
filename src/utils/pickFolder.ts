// 目录选择：桌面走 dialog 插件；Android 用自建 folder-picker 插件。
// tauri-plugin-dialog 在移动端没有实现目录选择（open({directory:true}) 会直接报
// "Folder picker is not implemented on mobile"），Android 侧由 Kotlin 的
// FolderPickerPlugin（ACTION_OPEN_DOCUMENT_TREE）提供，CI 会写进 gen/android。
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { isMobilePlatform } from '../chat/platform'

export interface PickFolderOptions {
  title?: string
}

export async function pickFolder(options?: PickFolderOptions): Promise<string | null | (string | null)[]> {
  if (!isMobilePlatform) {
    return await open({ directory: true, multiple: false, title: options?.title })
  }
  try {
    return await invoke<string | null>('pick_folder')
  } catch (err) {
    // 用户在系统设置里开了权限返回后重选；真正的取消走 resolve(null)。
    if (typeof err === 'string' && err.includes('所有文件访问')) {
      return await invoke<string | null>('pick_folder')
    }
    throw err
  }
}
