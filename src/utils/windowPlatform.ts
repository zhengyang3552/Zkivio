/** Window chrome capabilities shared by feature shells. */
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)

export const isWindows =
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

/**
 * Android：应用跑在单 WebView 的移动外壳里，没有窗口级 chrome
 * （最小化 / 最大化 / 关闭、拖拽改变窗口大小、多窗口、托盘都不存在）。
 * 见 src-tauri/src/android.rs 的模块注释。
 */
export const isAndroid =
  typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)

/**
 * 移动端外壳。目前只有 Android 走这条路（iOS 未接入）。
 *
 * 用途是切换布局形态，不是判断「是不是 Tauri」——桌面与移动都是 Tauri 运行时。
 * 走这个判断的地方应当只在形态上分叉（抽屉式侧栏、安全区、触摸命中区），
 * 不要用它做权限或能力判断，那类判断以后端返回为准。
 */
export const isMobilePlatform = isAndroid

export const usesNativeTitlebar = isMac
