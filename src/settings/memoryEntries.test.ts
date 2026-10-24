import { describe, expect, it } from 'vitest'
import {
  filterMemoryEntries,
  memoryEntryPreview,
  parseMemoryEntries,
  removeMemoryEntry,
  replaceMemoryEntryBody,
} from './memoryEntries'

const L1 = '# L1 Online Memory\n\n## 偏好\n\n回答用中文。\n\n## 工具\n\n先读再改。\n'

describe('parseMemoryEntries', () => {
  it('把二级标题切成条目，并跳过只有标题的文件头', () => {
    const entries = parseMemoryEntries(L1)
    expect(entries.map((entry) => entry.title)).toEqual(['偏好', '工具'])
    expect(entries[0].body).toBe('回答用中文。')
  })

  it('默认模板没有条目', () => {
    expect(parseMemoryEntries('# L1 Online Memory\n\n')).toEqual([])
    expect(parseMemoryEntries('# L2 Long-Term Memory\n')).toEqual([])
  })

  it('标题下的散列正文仍算一条（用户没写小标题时不能“看不见”）', () => {
    const entries = parseMemoryEntries('# L2 Long-Term Memory\n\n- 喜欢 TypeScript\n')
    expect(entries).toHaveLength(1)
    expect(entries[0].title).toBe('L2 Long-Term Memory')
    expect(entries[0].body).toBe('- 喜欢 TypeScript')
  })

  it('id 在同一次解析内唯一且稳定', () => {
    const first = parseMemoryEntries(L1)
    const second = parseMemoryEntries(L1)
    expect(new Set(first.map((entry) => entry.id)).size).toBe(first.length)
    expect(second.map((entry) => entry.id)).toEqual(first.map((entry) => entry.id))
  })
})

describe('removeMemoryEntry', () => {
  it('只删掉目标小节，保留标题与其它条目', () => {
    const [first] = parseMemoryEntries(L1)
    const next = removeMemoryEntry(L1, first.id)
    expect(next).toBe('# L1 Online Memory\n\n## 工具\n\n先读再改。\n')
  })

  it('删最后一条时不留多余空行', () => {
    const entries = parseMemoryEntries(L1)
    const next = removeMemoryEntry(L1, entries[1].id)
    expect(next).toBe('# L1 Online Memory\n\n## 偏好\n\n回答用中文。\n')
  })

  it('id 找不到时原样返回', () => {
    expect(removeMemoryEntry(L1, 'missing')).toBe(L1)
  })

  it('删掉唯一一条后只剩文件标题', () => {
    const content = '# L2 Long-Term Memory\n\n## 项目\n\nZkivio 用 Tauri。\n'
    const [entry] = parseMemoryEntries(content)
    expect(removeMemoryEntry(content, entry.id)).toBe('# L2 Long-Term Memory\n')
  })
})

describe('replaceMemoryEntryBody', () => {
  it('改写正文但保留小标题与相邻条目', () => {
    const [first] = parseMemoryEntries(L1)
    const next = replaceMemoryEntryBody(L1, first.id, '回答用简体中文，代码用英文注释。')
    expect(next).toContain('## 偏好\n\n回答用简体中文，代码用英文注释。\n')
    expect(next).toContain('## 工具\n\n先读再改。')
  })

  it('正文为空时只留标题', () => {
    const [first] = parseMemoryEntries(L1)
    const next = replaceMemoryEntryBody(L1, first.id, '   ')
    expect(next).toBe('# L1 Online Memory\n\n## 偏好\n\n## 工具\n\n先读再改。\n')
  })
})

describe('浏览辅助', () => {
  it('预览压平成一行并截断', () => {
    const [entry] = parseMemoryEntries('# L2\n\n## 长文\n\n' + 'a\n\nb'.repeat(200) + '\n')
    const preview = memoryEntryPreview(entry, 10)
    expect(preview.endsWith('…')).toBe(true)
    expect(Array.from(preview)).toHaveLength(11)
  })

  it('搜索匹配标题与正文，忽略大小写', () => {
    const entries = parseMemoryEntries(L1)
    expect(filterMemoryEntries(entries, '偏好')).toHaveLength(1)
    expect(filterMemoryEntries(entries, '先读')).toHaveLength(1)
    expect(filterMemoryEntries(entries, '')).toHaveLength(2)
    expect(filterMemoryEntries(entries, '不存在')).toHaveLength(0)
  })
})
