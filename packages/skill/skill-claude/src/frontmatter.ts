/**
 * Frontmatter parsing for Claude `SKILL.md` and command files. Claude Code
 * accepts values YAML rejects (an unquoted `: ` inside a description), so a
 * failed YAML parse falls back to a line parser that splits at the first colon.
 *
 * @module @deepseek-ai/dsh-skill-claude/frontmatter
 */

import { parse as parseYaml } from 'yaml'
import type { SkillInvocationPolicy } from '@deepseek-ai/dsh-skill'
import { splitSkillFrontmatter } from '@deepseek-ai/dsh-skill-filesystem'

/** One Claude file split into frontmatter fields and body. */
export interface ClaudeDocument {
  /** Frontmatter fields; empty when the file has no usable frontmatter. */
  readonly data: Record<string, unknown>
  /** Text after the frontmatter, or the whole file when there is none. */
  readonly body: string
}

/** A `key: value` frontmatter line; the key starts with a letter. */
const FIELD_LINE = /^([A-Za-z][\w-]*):[ \t]*(.*)$/
/** A Markdown heading of any level. */
const HEADING = /^#{1,6}[ \t]+(.+?)[ \t]*$/m

/**
 * Split and parse a Claude file.
 * @param raw - complete file text.
 * @returns the frontmatter fields and body.
 */
export function parseClaudeDocument(raw: string): ClaudeDocument {
  const text = raw.startsWith('﻿') ? raw.slice(1) : raw
  const split = splitSkillFrontmatter(text)
  if (split === undefined) return { data: {}, body: text }
  return { data: strictFields(split.yaml) ?? lenientFields(split.yaml), body: split.body }
}

function strictFields(yaml: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = parseYaml(yaml)
  } catch {
    // Values such as `description: a: b` are valid for Claude Code; the line parser handles them.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

function lenientFields(yaml: string): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  for (const line of yaml.split(/\r?\n/)) {
    const match = FIELD_LINE.exec(line)
    if (match !== null) data[match[1] as string] = unquote((match[2] as string).trim())
  }
  return data
}

function unquote(value: string): string {
  const quote = value[0]
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Read a non-empty string field.
 * @param data - frontmatter fields.
 * @param key - field name.
 * @returns the trimmed string, or `undefined` when absent, blank, or not a string.
 */
export function textField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function flagField(data: Record<string, unknown>, key: string): boolean | undefined {
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  return undefined
}

/**
 * Resolve the invocation policy from `disable-model-invocation` and `user-invocable`.
 * @param data - frontmatter fields.
 * @returns a policy that permits both surfaces unless a flag restricts one.
 */
export function invocationPolicy(data: Record<string, unknown>): SkillInvocationPolicy {
  return {
    modelInvocable: flagField(data, 'disable-model-invocation') !== true,
    userInvocable: flagField(data, 'user-invocable') !== false,
  }
}

/**
 * Describe a command file: its frontmatter description, else its first Markdown
 * heading, else its first non-empty line.
 * @param data - frontmatter fields.
 * @param body - text after the frontmatter.
 * @returns the description, or `undefined` when the file has no text.
 */
export function describeCommand(data: Record<string, unknown>, body: string): string | undefined {
  const described = textField(data, 'description')
  if (described !== undefined) return described
  const heading = HEADING.exec(body)
  if (heading !== null) return heading[1]
  return body.split(/\r?\n/).map(line => line.trim()).find(line => line !== '')
}
