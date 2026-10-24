/**
 * 工作区下载的进度换算。
 *
 * 后端推 `android-rootfs-progress` 事件（status / received / total），页面只负责把它变成
 * 进度条宽度和一个百分比。抽成纯函数是因为这里有两个容易出错、又没法靠肉眼验证的点：
 * 总字节数缺失时不能显示成「0% 卡住」，以及字节数越界（换了源、服务端长度不准）不能
 * 让宽度超过 100%。
 */

export type WorkspaceProgress = {
  /** 0–100 的整数，直接当进度条宽度。 */
  percent: number
  /** 总字节数未知：只能表达「在进行」，不能表达「完成了多少」。 */
  indeterminate: boolean
}

export function workspaceProgress(input: {
  status: string
  received: number
  total: number
}): WorkspaceProgress {
  // 解包没有字节进度可言，但下载已经完成，条必须是满的。
  if (input.status === 'extracting') return { percent: 100, indeterminate: false }
  if (!Number.isFinite(input.total) || input.total <= 0) return { percent: 0, indeterminate: true }
  if (!Number.isFinite(input.received) || input.received <= 0) return { percent: 0, indeterminate: false }
  const percent = Math.round((input.received / input.total) * 100)
  return { percent: Math.min(100, Math.max(0, percent)), indeterminate: false }
}
