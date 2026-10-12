import { useEffect } from 'react'

/**
 * 移动端软键盘适配。
 *
 * 把「布局视口高度 - 可视视口高度 - 可视视口顶部偏移」写进文档根的
 * `--kb-inset`（即软键盘露出时被遮挡的高度）。输入栏外层用
 * `padding-bottom: var(--kb-inset, 0px)` 据此整体上移，跟随输入法高度。
 *
 * 桌面端没有软键盘，可视视口恒等于布局视口，差值恒为 0，`--kb-inset`
 * 不会被设置，`var(--kb-inset, 0px)` 回落 0，无任何副作用。jsdom 下
 * `visualViewport` 不存在或指针非 coarse，直接跳过。
 */
export function useKeyboardInset(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const vv = window.visualViewport
    if (!vv) return
    // 只在粗指针（触屏）设备上启用，避免桌面/无谓监听。
    const coarse = typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: coarse)').matches
    if (!coarse) return

    let frame = 0
    const apply = () => {
      frame = 0
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      const root = document.documentElement
      if (inset > 0) root.style.setProperty('--kb-inset', `${inset}px`)
      else root.style.removeProperty('--kb-inset')
    }
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(apply)
    }
    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    apply()
    return () => {
      vv.removeEventListener('resize', schedule)
      vv.removeEventListener('scroll', schedule)
      if (frame) cancelAnimationFrame(frame)
      document.documentElement.style.removeProperty('--kb-inset')
    }
  }, [])
}
