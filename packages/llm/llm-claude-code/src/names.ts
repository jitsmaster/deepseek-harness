/**
 * Tool-name aliasing between DSH tools and the MCP tools Claude Code sees. The
 * stub MCP server is named `dsh`, so Claude calls a DSH tool `mcp__dsh__<alias>`;
 * the whole name must match `^[A-Za-z0-9_-]{1,64}$`, which leaves 54 characters
 * for the alias.
 * @module @deepseek-ai/dsh-llm-claude-code/names
 */

import { createHash } from 'node:crypto'

/** MCP server name the stub registers under (the `mcp.json` key). */
export const MCP_SERVER_NAME = 'dsh'

/** Prefix Claude Code puts before every tool of the stub server. */
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`

/** Longest alias that still fits behind {@link MCP_TOOL_PREFIX} inside Claude's 64-character tool-name limit. */
const MAX_ALIAS_LENGTH = 64 - MCP_TOOL_PREFIX.length

const SAFE_ALIAS = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_ALIAS_LENGTH}}$`, 'u')

/** Hex digits of the hash appended to a sanitised alias. */
const HASH_LENGTH = 8

/** Two-way map between DSH tool names and their MCP aliases for one call. */
export interface ToolAliases {
  /** @returns the alias Claude is shown for a DSH tool (the name itself when it already fits). */
  aliasOf(name: string): string
  /** @returns the DSH tool name for an alias, or the alias itself when it is not one of ours. */
  nameOf(alias: string): string
}

function hashOf(value: string, salt: number): string {
  return createHash('sha256').update(salt === 0 ? value : `${salt}:${value}`).digest('hex').slice(0, HASH_LENGTH)
}

/**
 * Build the aliases for one request's tools. Names that already fit keep their
 * own spelling; others become a sanitised prefix plus a short hash of the real
 * name, rehashed with a salt when that alias is already taken.
 * @param names - the DSH tool names of the request.
 * @returns the per-call alias map.
 */
export function buildToolAliases(names: readonly string[]): ToolAliases {
  const toAlias = new Map<string, string>()
  const toName = new Map<string, string>()
  const fitting = names.filter(name => SAFE_ALIAS.test(name))
  // Fitting names claim their own spelling first so no generated alias can displace one.
  for (const name of fitting) {
    toAlias.set(name, name)
    toName.set(name, name)
  }
  for (const name of names) {
    if (toAlias.has(name)) continue
    const stem = name.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, MAX_ALIAS_LENGTH - HASH_LENGTH - 1)
    let alias = ''
    for (let salt = 0; ; salt += 1) {
      alias = `${stem.length > 0 ? stem : 'tool'}_${hashOf(name, salt)}`
      if (!toName.has(alias)) break
    }
    toAlias.set(name, alias)
    toName.set(alias, name)
  }
  return {
    aliasOf: name => toAlias.get(name) ?? name,
    nameOf: alias => toName.get(alias) ?? alias,
  }
}
