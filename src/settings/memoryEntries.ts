/**
 * 记忆条目的纯解析与改写。
 *
 * 记忆文件本身是 Markdown（`# L1 / L2` 标题 + `##` 小节）。设置页原先只有整份文本的
 * 编辑框，「看已存了什么、删掉某一条」都得自己在一屏 Markdown 里找。这里把同一份内容
 * 解析成条目列表：浏览与增删改都只读快照、只回写整份内容，文件的权威性仍归后端
 * `chat_memory_save`（字节上限、凭据检查、原子写入都在那里）。
 *
 * 因此本模块不缓存、不持有状态：每次从内容现算条目，操作返回改写后的新内容。
 */

export type MemoryEntry = {
  /** 条目在内容中的起始偏移量，同一次解析内唯一，可直接当 key 用。 */
  id: string
  /** 小标题原文（含 `#` 前缀）；无标题的正文块为空串。 */
  heading: string
  /** 去掉 `#` 的小标题文本，用于展示与搜索。 */
  title: string
  /** 小标题之后、下一个小标题之前的正文（已去掉首尾空白）。 */
  body: string
  /** 小标题行在内容中的起始偏移量。 */
  start: number
  /** 正文在内容中的起始偏移量：改写正文时从这里切。 */
  bodyStart: number
  /** 条目结束偏移量（下一个小标题的起点或内容末尾）。 */
  end: number
}

const HEADING = /^(#{1,6})\s+\S/

type Line = { text: string; start: number; end: number }

/** 按行切分并保留每行的偏移量；末尾没有换行的最后一行也算一行。 */
function readLines(content: string): Line[] {
  const lines: Line[] = []
  let start = 0
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '\n') continue
    lines.push({ text: content.slice(start, index), start, end: index + 1 })
    start = index + 1
  }
  if (start < content.length) lines.push({ text: content.slice(start), start, end: content.length })
  return lines
}

/**
 * 解析条目。
 *
 * 一级标题（`# ...`）且正文为空时当作文件标题而不是条目 —— 默认模板就是
 * `# L1 Online Memory`，把它列成一条「空记忆」会让人以为存了没用的东西。
 */
export function parseMemoryEntries(content: string): MemoryEntry[] {
  const lines = readLines(content)
  const sections: Array<{ heading: string; start: number; bodyStart: number; bodyEnd: number }> = []
  let current: { heading: string; start: number; bodyStart: number } | null = null
  for (const line of lines) {
    if (HEADING.test(line.text)) {
      if (current) sections.push({ ...current, bodyEnd: line.start })
      current = { heading: line.text.trim(), start: line.start, bodyStart: line.end }
    }
  }
  if (current) sections.push({ ...current, bodyEnd: content.length })

  return sections
    .map((section) => {
      const body = content.slice(section.bodyStart, section.bodyEnd).trim()
      const level = section.heading.match(/^#+/)?.[0].length ?? 0
      const title = section.heading.replace(/^#+\s*/, '').trim()
      return { section, body, level, title }
    })
    // 只有标题、没有正文的一级标题是文件标题，不算条目。
    .filter(({ body, level }) => body.length > 0 || level > 1)
    .map(({ section, body, title }) => ({
      id: String(section.start),
      heading: section.heading,
      title,
      body,
      start: section.start,
      bodyStart: section.bodyStart,
      end: section.bodyEnd,
    }))
}

/** 删掉一条记忆，并把接缝处的空行收成一个 —— 不碰其它条目的内容。 */
export function removeMemoryEntry(content: string, id: string): string {
  const entry = parseMemoryEntries(content).find((item) => item.id === id)
  if (!entry) return content
  const head = content.slice(0, entry.start).replace(/\s+$/, '')
  const tail = content.slice(entry.end).replace(/^\s+/, '')
  const joined = !head ? tail : !tail ? head : `${head}\n\n${tail}`
  if (!joined) return ''
  return joined.endsWith('\n') ? joined : `${joined}\n`
}

/** 改写一条记忆的正文，保留它的小标题与相邻条目。 */
export function replaceMemoryEntryBody(content: string, id: string, body: string): string {
  const entry = parseMemoryEntries(content).find((item) => item.id === id)
  if (!entry) return content
  const next = body.trim()
  const rest = content.slice(entry.end).replace(/^\s+/, '')
  // 标题行自带换行，正文前补一个空行；没有正文时只留这个空行。
  const block = next ? `\n${next}\n` : ''
  return content.slice(0, entry.bodyStart) + (rest ? `${block}\n${rest}` : block)
}

/** 浏览列表用的一行摘要：正文首行，去掉多余空白。 */
export function memoryEntryPreview(entry: MemoryEntry, maxChars = 90): string {
  const compact = entry.body.replace(/\s+/g, ' ').trim()
  const chars = Array.from(compact)
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : compact
}

/** 按标题与正文做大小写无关的包含匹配；关键词全空时返回全部条目。 */
export function filterMemoryEntries(entries: MemoryEntry[], query: string): MemoryEntry[] {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return entries
  return entries.filter((entry) => `${entry.title}\n${entry.body}`.toLowerCase().includes(keyword))
}
