/**
 * Name derivation for Claude skills: Claude names may contain `:` and mixed
 * case, while the DSH skill registry accepts only lowercase kebab-case.
 *
 * @module @deepseek-ai/dsh-skill-claude/names
 */

/** Every run of characters a DSH skill name cannot contain. */
const NON_NAME_RUN = /[^a-z0-9]+/g
/** Leading and trailing dashes left after replacement. */
const EDGE_DASHES = /^-+|-+$/g

/**
 * Normalize a Claude identifier to a DSH skill name.
 * @param identifier - Claude skill or command identifier, for example `modes:sparc`.
 * @returns the kebab-case name, or `undefined` when no letters or digits remain.
 */
export function toSkillName(identifier: string): string | undefined {
  const name = identifier.toLowerCase().replaceAll(NON_NAME_RUN, '-').replaceAll(EDGE_DASHES, '')
  return name === '' ? undefined : name
}

/**
 * Derive Claude's namespaced command identifier from a path below `commands/`.
 * @param relativePath - file path relative to the commands root, with `/` or `\` separators.
 * @returns the identifier with segments joined by `:` and no `.md` extension.
 */
export function commandIdentifier(relativePath: string): string {
  return relativePath.replace(/\.md$/i, '').split(/[\\/]/).join(':')
}

/**
 * Prefix a plugin's identifiers with the plugin name.
 * @param plugin - plugin name, or `undefined` for project and user sources.
 * @param identifier - skill or command identifier inside the source.
 * @returns the identifier, namespaced by the plugin when there is one.
 */
export function qualifiedIdentifier(plugin: string | undefined, identifier: string): string {
  return plugin === undefined ? identifier : `${plugin}:${identifier}`
}
