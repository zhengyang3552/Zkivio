import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './styles/app.css'
import 'streamdown/styles.css'
import { isTauriRuntime } from './api/tauri'
import { startBackendSettingsSync } from './api/settingsCache'
import { startModelDatabaseSync } from './data/modelDatabaseSync'
import { restoreBackupInterface } from './api/backupInterface'

if (isTauriRuntime()) {
  const backendSettingsSync = startBackendSettingsSync().catch((error) => {
    console.error('[settingsCache] could not subscribe to backend updates', error)
    return () => {}
  })
  if (import.meta.hot) import.meta.hot.dispose(() => { void backendSettingsSync.then((stop) => stop()) })
}

// 屏蔽 WebView 原生右键菜单（Back/Reload/Inspect）
document.addEventListener('contextmenu', (e) => e.preventDefault())

// React 应用入口文件
// 使用 createRoot 将 App 组件挂载到 DOM 的 #root 元素上
function mountApp() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
}

if (isTauriRuntime()) {
  // 启动链路里的两步都是「有则更好」，任何一步失败都不该让窗口只剩一行错误：
  //   - 备份界面状态：后端缺这条命令（旧版/不同平台的命令表不一致）时按没有备份处理；
  //   - 模型库同步：失败就继续用磁盘上已有的目录，不把整个应用卡在启动前。
  // 真正的加载失败由 App 自己的错误界面呈现，这里只记录原因。
  void (async () => {
    try {
      await restoreBackupInterface()
    } catch (error) {
      console.error('[startup] could not restore the backup interface', error)
    }
    let stop: () => void = () => {}
    try {
      stop = await startModelDatabaseSync()
    } catch (error) {
      console.error('[startup] could not sync the model database', error)
    }
    if (import.meta.hot) import.meta.hot.dispose(stop)
    mountApp()
  })()
} else {
  mountApp()
}
