import { ErrorNotice } from '../../components/AppNotice'
import { useMemo, useState } from 'react'
import { RefreshCw, FolderOpen, PencilLine, Trash2 } from 'lucide-react'
import { SettingRow, SettingsGroup, Toggle, TextArea } from '../components'
import { Button, IconButton } from '../../components/Button'
import { confirmDialog } from '../../components/dialogQueue'
import {
  MEMORY_L1_MAX_BYTES,
  utf8ByteLength,
  type MemoryLayerKey,
} from '../memoryLayers'
import {
  filterMemoryEntries,
  memoryEntryPreview,
  parseMemoryEntries,
  removeMemoryEntry,
  replaceMemoryEntryBody,
} from '../memoryEntries'
import type { Lang } from '../../components/i18n'
import type { ChatMemoryConfig } from '../../api/tauri'
import { isMobilePlatform } from '../../utils/windowPlatform'

/**
 * 单层记忆编辑器。原本在 SettingsShell 模块作用域，只被记忆标签页使用，
 * 随 MemoryTab 一起搬过来。
 */
function MemoryEditor({
  layer,
  title,
  description,
  value,
  savedValue,
  maxBytes,
  rows,
  loading,
  saving,
  lang,
  onChange,
  onSave,
  onReload,
}: {
  layer: MemoryLayerKey
  title: string
  description: string
  value: string
  savedValue: string
  maxBytes?: number
  rows: number
  loading: boolean
  saving: boolean
  lang: string
  onChange: (value: string) => void
  onSave: () => void
  onReload: () => void
}) {
  const bytes = utf8ByteLength(value)
  const overLimit = maxBytes !== undefined && bytes > maxBytes
  const dirty = value !== savedValue
  return (
    <div className="kv-panel mb-2">
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="kv-panel-title !mb-1">
            {title}
            <span className={`kv-tag ${overLimit ? 'danger' : dirty ? 'warn' : 'ok'}`}>
              {maxBytes ? `${bytes} / ${maxBytes} bytes` : `${bytes} bytes`}
            </span>
          </div>
          <div className="kv-panel-body">{description}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            size="sm"
            onClick={onReload}
            disabled={loading || saving}
            data-tauri-drag-region="false"
          >
            <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
            {lang === 'zh' ? '重载' : 'Reload'}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            disabled={loading || saving || !dirty || overLimit}
            data-tauri-drag-region="false"
          >
            {saving ? (lang === 'zh' ? '保存中' : 'Saving') : (lang === 'zh' ? '保存' : 'Save')}
          </Button>
        </div>
      </div>
      <TextArea
        value={value}
        onChange={onChange}
        rows={rows}
        mono
        className="min-h-[160px]"
        spellCheck={false}
        aria-label={title}
      />
      {overLimit && (
        <p className="mt-1.5 text-[11px] leading-snug text-red-500 dark:text-red-400">
          {lang === 'zh'
            ? `${layer.toUpperCase()} 超出字节上限，保存前需要精简。`
            : `${layer.toUpperCase()} is over its byte limit.`}
        </p>
      )}
    </div>
  )
}

interface MemoryTabProps {
  lang: Lang
  chatMemory: ChatMemoryConfig
  memoryDir: string
  memoryError: string
  memorySuccess: string
  memoryLoading: boolean
  memorySavingLayer: MemoryLayerKey | null
  memoryDrafts: Record<MemoryLayerKey, string>
  memorySnapshots: Record<MemoryLayerKey, string>
  onUpdateChatMemory: (updates: Partial<ChatMemoryConfig>) => void
  onRefresh: () => void
  onOpenFolder: () => void
  onDraftChange: (layer: MemoryLayerKey, value: string) => void
  onSaveLayer: (layer: MemoryLayerKey) => void
  onReplaceLayerContent: (layer: MemoryLayerKey, content: string) => void
}

/** 记忆标签页。纯展示；加载、保存与草稿由记忆编辑 owner 管理。 */
export function MemoryTab({
  lang,
  chatMemory,
  memoryDir,
  memoryError,
  memorySuccess,
  memoryLoading,
  memorySavingLayer,
  memoryDrafts,
  memorySnapshots,
  onUpdateChatMemory,
  onRefresh,
  onOpenFolder,
  onDraftChange,
  onSaveLayer,
  onReplaceLayerContent,
}: MemoryTabProps) {
  const [browseLayer, setBrowseLayer] = useState<MemoryLayerKey>('l1')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)

  const entries = useMemo(
    () => ({
      l1: parseMemoryEntries(memorySnapshots.l1),
      l2: parseMemoryEntries(memorySnapshots.l2),
    }),
    [memorySnapshots.l1, memorySnapshots.l2],
  )
  const visible = useMemo(
    () => filterMemoryEntries(entries[browseLayer], query),
    [entries, browseLayer, query],
  )
  const dirty = memoryDrafts[browseLayer] !== memorySnapshots[browseLayer]
  const saving = memorySavingLayer !== null
  const zh = lang === 'zh'

  const handleDelete = async (entry: { id: string; title: string }) => {
    const confirmed = await confirmDialog({
      title: zh ? '删除这条记忆？' : 'Delete this memory?',
      message: zh
        ? `「${entry.title || '未命名条目'}」会从 ${browseLayer.toUpperCase()} 里删除，且无法恢复。`
        : `“${entry.title || 'Untitled entry'}” is removed from ${browseLayer.toUpperCase()} and cannot be recovered.`,
      confirmLabel: zh ? '删除' : 'Delete',
      danger: true,
    })
    if (!confirmed) return
    setEditing(null)
    onReplaceLayerContent(browseLayer, removeMemoryEntry(memorySnapshots[browseLayer], entry.id))
  }

  return (
    <>
      <SettingsGroup title={zh ? '记忆运行' : 'Memory runtime'}>
        <SettingRow
          label={zh ? '启用记忆' : 'Enable memory'}
          description={zh
            ? '开启后注入 L1，并暴露 memory 工具。'
            : 'Injects L1 and exposes memory tools.'}
        >
          <Toggle
            checked={chatMemory.enabled}
            onChange={(enabled) => onUpdateChatMemory({ enabled })}
          />
        </SettingRow>
        <SettingRow label={zh ? '记忆文件夹' : 'Memory folder'} stack>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={onRefresh}
              disabled={memoryLoading}
              data-tauri-drag-region="false"
            >
              <RefreshCw size={10} className={memoryLoading ? 'animate-spin' : ''} />
              {zh ? '刷新' : 'Refresh'}
            </Button>
            {/* 打开文件夹依赖系统文件管理器；安卓的应用私有目录对外不可见，
                点击只会得到 No Activity found，移动端不渲染这个按钮。 */}
            {!isMobilePlatform && (
              <Button
                size="sm"
                onClick={onOpenFolder}
                data-tauri-drag-region="false"
              >
                <FolderOpen size={11} />
                {zh ? '打开文件夹' : 'Open folder'}
              </Button>
            )}
            {memoryDir && <span className="kv-row-desc min-w-0 break-all">{memoryDir}</span>}
          </div>
        </SettingRow>
        {memoryError && <ErrorNotice message={memoryError} />}
        {memorySuccess && (
          <div className="kv-panel info">
            <div className="kv-panel-body">{memorySuccess}</div>
          </div>
        )}
      </SettingsGroup>

      {/* 已存记忆：按条目浏览、改正文、删除。整份 Markdown 的读写仍是唯一权威。 */}
      <SettingsGroup title={zh ? '已存记忆' : 'Stored memories'}>
        <div className="px-1 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="kv-seg w-fit">
              {(['l1', 'l2'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={browseLayer === key ? 'active' : ''}
                  aria-pressed={browseLayer === key}
                  onClick={() => {
                    setEditing(null)
                    setBrowseLayer(key)
                  }}
                  data-tauri-drag-region="false"
                >
                  {key.toUpperCase()} · {entries[key].length}
                </button>
              ))}
            </div>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={zh ? '搜索条目' : 'Search entries'}
              aria-label={zh ? '搜索记忆条目' : 'Search memory entries'}
              className="kv-input ml-auto w-[160px] min-w-0 flex-1"
              data-tauri-drag-region="false"
            />
          </div>
          <p className="kv-row-desc mt-1.5">
            {dirty
              ? (zh
                ? '下方编辑框有未保存的改动，先保存才能改写或删除条目。'
                : 'Save the editor below before rewriting or deleting entries.')
              : (zh
                ? `${browseLayer.toUpperCase()} 共 ${entries[browseLayer].length} 条，点击可展开正文。`
                : `${entries[browseLayer].length} entries in ${browseLayer.toUpperCase()}.`)}
          </p>
        </div>

        {visible.length === 0 ? (
          <div className="px-1 py-2">
            <p className="kv-row-desc">
              {entries[browseLayer].length === 0
                ? (zh ? '还没有已存的记忆。代理写入后，条目会出现在这里。' : 'No stored memories yet. Entries appear here once the agent writes them.')
                : (zh ? '没有匹配的条目。' : 'No entries match your search.')}
            </p>
          </div>
        ) : (
          <ul className="custom-scrollbar m-0 max-h-[320px] list-none overflow-y-auto p-0">
            {visible.map((entry) => {
              const isEditing = editing?.id === entry.id
              return (
                <li key={entry.id} className="border-t border-[var(--border)] px-1 py-2 first:border-t-0">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="kv-row-label truncate">
                        {entry.title || (zh ? '未命名条目' : 'Untitled entry')}
                      </div>
                      {!isEditing && (
                        <p className="kv-row-desc mt-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]">
                          {memoryEntryPreview(entry) || (zh ? '（正文为空）' : '(empty)')}
                        </p>
                      )}
                    </div>
                    {!isEditing && (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          size="sm"
                          disabled={dirty || saving}
                          onClick={() => setEditing({ id: entry.id, body: entry.body })}
                          data-tauri-drag-region="false"
                        >
                          <PencilLine size={11} />
                          {zh ? '编辑' : 'Edit'}
                        </Button>
                        <IconButton
                          size="xs"
                          variant="danger"
                          label={zh ? '删除这条记忆' : 'Delete this memory'}
                          disabled={dirty || saving}
                          onClick={() => void handleDelete(entry)}
                        >
                          <Trash2 size={13} />
                        </IconButton>
                      </div>
                    )}
                  </div>

                  {isEditing && editing && (
                    <div className="mt-2">
                      <TextArea
                        value={editing.body}
                        onChange={(body) => setEditing({ id: entry.id, body })}
                        rows={6}
                        mono
                        aria-label={zh ? '编辑条目正文' : 'Edit entry body'}
                      />
                      <div className="mt-2 flex items-center justify-end gap-1.5">
                        <Button size="sm" onClick={() => setEditing(null)} data-tauri-drag-region="false">
                          {zh ? '取消' : 'Cancel'}
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={saving || editing.body === entry.body}
                          onClick={() => {
                            onReplaceLayerContent(
                              browseLayer,
                              replaceMemoryEntryBody(memorySnapshots[browseLayer], entry.id, editing.body),
                            )
                            setEditing(null)
                          }}
                          data-tauri-drag-region="false"
                        >
                          {zh ? '保存条目' : 'Save entry'}
                        </Button>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </SettingsGroup>

      {/* L1 / L2 编辑器自带标题+描述+按钮，面板间用 mb-2 直接留间距（无额外容器层） */}
      <MemoryEditor
        layer="l1"
        title={zh ? 'L1 在线记忆' : 'L1 Online Memory'}
        description={zh
          ? '每次回答都会参考的偏好与约束。'
          : 'Preferences and constraints applied to every reply.'}
        value={memoryDrafts.l1}
        savedValue={memorySnapshots.l1}
        maxBytes={MEMORY_L1_MAX_BYTES}
        rows={9}
        loading={memoryLoading}
        saving={memorySavingLayer === 'l1'}
        lang={lang}
        onChange={(value) => onDraftChange('l1', value)}
        onSave={() => onSaveLayer('l1')}
        onReload={onRefresh}
      />

      <MemoryEditor
        layer="l2"
        title={zh ? 'L2 长期记忆' : 'L2 Long-Term Memory'}
        description={zh
          ? '长期记录，按需通过 memory 工具读取。'
          : 'Long-term notes, read on demand via memory tools.'}
        value={memoryDrafts.l2}
        savedValue={memorySnapshots.l2}
        rows={13}
        loading={memoryLoading}
        saving={memorySavingLayer === 'l2'}
        lang={lang}
        onChange={(value) => onDraftChange('l2', value)}
        onSave={() => onSaveLayer('l2')}
        onReload={onRefresh}
      />
    </>
  )
}
