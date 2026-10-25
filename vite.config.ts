/// <reference types="vitest" />
import eventSchema from './src/generated/chatProtocol.schema.json'
import syncSchema from './src/generated/chatSync.schema.json'
import Ajv2020 from 'ajv/dist/2020'
import standaloneCode from 'ajv/dist/standalone'
import { _ } from 'ajv/dist/compile/codegen'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Compile generated schemas in Node; the WebView CSP forbids runtime code generation. */
function chatProtocolValidators(): Plugin {
  const moduleId = 'virtual:chat-protocol-validators'
  const resolvedId = `\0${moduleId}`
  return {
    name: 'chat-protocol-validators',
    resolveId(id) { if (id === moduleId) return resolvedId },
    load(id) {
      if (id !== resolvedId) return
      const ajv = new Ajv2020({
        allErrors: true,
        strict: false,
        code: {
          source: true,
          esm: true,
          formats: _`({double: {type: 'number', validate: Number.isFinite}})`,
        },
        formats: {
          float: true, uint8: true, uint32: true, uint64: true, int64: true,
          double: { type: 'number', validate: Number.isFinite },
        },
      })
      ajv.addSchema(eventSchema, 'event')
      ajv.addSchema(syncSchema, 'sync')
      return standaloneCode(ajv, { validateEvent: 'event', validateSync: 'sync' })
    },
  }
}

/** Serve and bundle PDF.js resources locally; filenames must retain their CMap names. */
function pdfResources(): Plugin {
  const root = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
  const assets = new Map<string, Buffer>()
  for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
    for (const name of readdirSync(join(root, directory))) {
      assets.set(`${directory}/${name}`, readFileSync(join(root, directory, name)))
    }
  }
  return {
    name: 'pdfjs-local-resources',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const key = new URL(request.url ?? '/', 'http://localhost').pathname.slice(1)
        const data = assets.get(key)
        if (!data) { next(); return }
        response.setHeader('Content-Type', key.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream')
        response.end(data)
      })
    },
    generateBundle() {
      for (const [name, source] of assets)
        this.emitFile({ type: 'asset', fileName: `pdfjs/${name}`, source })
    },
  }
}

/**
 * 构建产物里，所有依赖 color-mix 的声明都被 Tailwind/Lightning 降级成
 * 「纯色兜底 + @supports 包裹的 color-mix」两份。兜底的值是 var(--text)/var(--accent)
 * 这类**纯色**：在不支持 color-mix 的 WebView（如 Android System WebView 110）上
 * 会命中兜底 —— 深色主题里点一下按钮/选中一行，背景整块变成白色、文字同色不可见。
 *
 * 这类纯色兜底比「没有颜色」更糟：没有颜色只是没有反馈，纯色是反色色块。
 * 因此构建时把「值恰为 var(--text)/var(--accent)」的兜底声明删掉：老 WebView 上
 * color-mix 本就被 @supports 挡掉，删掉兜底后属性回落为无色（透明），
 * 现代 WebView 仍然走 color-mix 分支，视觉不变。
 *
 * 资源类兜底（如 --success-soft: var(--success)、border-color: var(--border)）
 * 不在删除范围：它们要么已在源码层修成显式 rgba，要么退化后语义仍成立。
 */
function stripColorMixSolidFallbacks(): Plugin {
  const GUARD = '@supports (color:color-mix(in lab,red,red))'
  const isDangerousFallback = (body: string) =>
    body
      .split(';')
      .filter((decl) => decl.trim().length > 0)
      .every((decl) => {
        const value = decl.slice(decl.indexOf(':') + 1).trim()
        return value.startsWith('var(--text)') || value.startsWith('var(--accent)')
      })

  const strip = (css: string): string =>
    // Tailwind/Lightning 给每条 color-mix 生成「纯色兜底 + @supports 包裹的正主」。
    // 兜底值恰为 var(--text)/var(--accent) 这类纯色：不支持 color-mix 的 WebView
    // （如 Android System WebView 110）会命中它 —— 深色主题里点一下按钮/选中一行，
    // 背景变成一块白色、文字同色不可见（白色胶囊截图）。
    //
    // 只把「背景/边框/阴影」类兜底改写成 transparent：老 WebView 上回落为无色
    // （没有反馈但可读），现代 WebView 仍走 color-mix 分支，视觉不变。
    // 文字类属性（color/fill/stroke）与自定义属性（--*，消费方不固定、很可能是文字色）
    // 必须保留纯色兜底 —— 上一版把它们也改成了 transparent，结果 WebView 110 上
    // 文字整片透明（「字没了」），比白色色块更糟。
    // 形态限定「属性:var(--x)} + 紧跟 @supports」，不会误伤普通引用这些变量的声明。
    css.replace(
      /([-a-z]+)\s*:\s*var\(--(?:text|accent|success|warn)\)\}@supports \(color:color-mix/g,
      (match, prop: string) => {
        const isTextColor =
          prop === 'color' || prop === 'fill' || prop === 'stroke' || prop.startsWith('--')
        if (isTextColor) return match
        // 兜底值不能给 transparent：老 WebView 上 hover/选中反馈会完全消失
        //（用户实测反馈「选中色改没了」）。按语义换成主题自适应的淡色：
        //   --text  → --tint-overlay（明色板淡黑 / 暗色板淡白，见 index.css）
        //   --accent/--success/--warn → 各自的 -soft 实色 token（本就是淡色）
        let fallback = 'var(--tint-overlay)'
        if (match.includes('var(--accent)')) fallback = 'var(--accent-soft)'
        else if (match.includes('var(--success)')) fallback = 'var(--success-soft)'
        else if (match.includes('var(--warn)')) fallback = 'var(--warn-soft)'
        return `${prop}:${fallback}}@supports (color:color-mix`
      },
    )

  return {
    name: 'strip-color-mix-solid-fallbacks',
    generateBundle(_, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.css')) continue
        console.log('[strip-color-mix] processing', file.fileName)
        const source = typeof file.source === 'string' ? file.source : Buffer.from(file.source).toString('utf8')
        const stripped = strip(source)
        if (stripped !== source) {
          console.log('[strip-color-mix] stripped fallbacks in', file.fileName, source.length, '->', stripped.length)
        }
        file.source = stripped
      }
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  base: './',
  plugins: [chatProtocolValidators(), pdfResources(), stripColorMixSolidFallbacks(), react()],
  build: {
    target: 'esnext',
  },
  test: {
    // 路由底色回归需要真实 CSS；其余样式仍按默认跳过。
    css: { include: [/chat-01-main\.css/] },
    environment: 'node',
    environmentMatchGlobs: [
      ['src/**/*.test.tsx', 'jsdom'],
      ['extensions/**/*.test.tsx', 'jsdom'],
    ],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'extensions/**/*.{test,spec}.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
})
