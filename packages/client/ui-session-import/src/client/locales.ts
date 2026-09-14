/**
 * `session-import` namespace dictionary: the "Import from Claude Code" dialog
 * and its trigger.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'dialog.title': '从 Claude Code 导入',
  'dialog.close': '关闭',
  'dialog.cancel': '取消',
  'dialog.import': '导入',
  'dialog.empty': '未找到 Claude Code 会话。',
  'dialog.loading': '正在查找 Claude Code 会话…',
  'dialog.searchPlaceholder': '按名称或路径搜索…',
  'dialog.noMatches': '没有会话与搜索匹配。',
  'sections.running': '运行中',
  'sections.done': '已结束',
} satisfies Record<string, string>

/** The session-import namespace key union. */
export type SessionImportKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'dialog.title': 'Import from Claude Code',
  'dialog.close': 'Close',
  'dialog.cancel': 'Cancel',
  'dialog.import': 'Import',
  'dialog.empty': 'No Claude Code sessions found.',
  'dialog.loading': 'Looking for Claude Code sessions…',
  'dialog.searchPlaceholder': 'Search by name or path…',
  'dialog.noMatches': 'No sessions match your search.',
  'sections.running': 'Running',
  'sections.done': 'Finished',
} satisfies Record<SessionImportKey, string>
