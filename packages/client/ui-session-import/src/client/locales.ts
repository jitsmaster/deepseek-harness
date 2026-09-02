/**
 * `session-import` namespace dictionary: the "Import from Claude Code" dialog
 * and its trigger.
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger.aria': '从 Claude Code 导入',
  'dialog.title': '从 Claude Code 导入',
  'dialog.close': '关闭',
  'dialog.cancel': '取消',
  'dialog.import': '导入',
  'dialog.empty': '未找到 Claude Code 会话。',
  'dialog.loading': '正在查找 Claude Code 会话…',
} satisfies Record<string, string>

/** The session-import namespace key union. */
export type SessionImportKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger.aria': 'Import from Claude Code',
  'dialog.title': 'Import from Claude Code',
  'dialog.close': 'Close',
  'dialog.cancel': 'Cancel',
  'dialog.import': 'Import',
  'dialog.empty': 'No Claude Code sessions found.',
  'dialog.loading': 'Looking for Claude Code sessions…',
} satisfies Record<SessionImportKey, string>
