/**
 * Fake `claude -p` for the web-search-claude-code specs. `harness.ts` routes
 * the provider's spawn of the configured executable to `node fake-claude.cjs
 * <the real claude argv>`. This script reads the prompt from stdin, appends one
 * JSON record per run to `$FAKE_CLAUDE_LOG` (argv, cwd, stdin), then prints
 * canned stream-json chosen by the `scenario:<word>` found in the prompt.
 */
'use strict'

const { appendFileSync, readdirSync, readFileSync } = require('node:fs')

const SEARCH_ID = 'toolu_search'
const LINKS = [
  { title: 'Alpha', url: 'https://a.example/' },
  { title: 'Beta', url: 'https://b.example/' },
  { title: 'Gamma', url: 'https://c.example/' },
]

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n')
}

function assistantSearch() {
  emit({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: SEARCH_ID, name: 'WebSearch', input: { query: 'q', mode: 'standard' } }] },
  })
}

function searchResult(text, extra = {}) {
  emit({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: SEARCH_ID, content: text, ...extra }] },
  })
}

function linksText(links) {
  return `Web search results for query: "q"\n\nLinks: ${JSON.stringify(links)}\n\nSome extra context.`
}

function success(result) {
  emit({ type: 'result', subtype: 'success', is_error: false, result, permission_denials: [] })
}

const scenarios = {
  success() {
    emit({ type: 'system', subtype: 'init', tools: ['WebSearch'] })
    assistantSearch()
    searchResult(linksText(LINKS))
    success('Alpha says A. See https://a.example/.')
  },
  arraycontent() {
    assistantSearch()
    searchResult([{ type: 'text', text: linksText(LINKS) }])
    success('Array content answer.')
  },
  malformed() {
    process.stdout.write('not json at all\n')
    process.stdout.write('{"type":"assistant", broken\n')
    process.stdout.write('\n')
    assistantSearch()
    searchResult(linksText([{ title: 'Ok', url: 'https://ok.example/' }, { title: 'No url' }, 'junk', { url: 7 }]))
    process.stdout.write('[1,2,3]\n')
    success('Survived malformed lines.')
  },
  badlinks() {
    assistantSearch()
    searchResult('Web search results for query: "q"\n\nLinks: [{"title": oops\n\nTrailing text.')
    success('Answer without parseable links.')
  },
  nolinks() {
    assistantSearch()
    searchResult('Web search results for query: "q"\n\nNo links found.')
    success('Answer without links.')
  },
  resulterror() {
    assistantSearch()
    searchResult(linksText(LINKS))
    emit({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'] })
  },
  iserror() {
    assistantSearch()
    searchResult(linksText(LINKS))
    emit({ type: 'result', subtype: 'success', is_error: true, result: 'Credit balance is too low' })
  },
  nosearch() {
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will not search.' }] } })
    success('I answered from memory.')
  },
  toolerror() {
    assistantSearch()
    searchResult('Web search is unavailable', { is_error: true })
    success('Could not search.')
  },
  noresult() {
    assistantSearch()
    searchResult(linksText(LINKS))
  },
  exit3() {
    process.stderr.write('claude: not logged in\n')
    process.exitCode = 3
  },
  twice() {
    assistantSearch()
    searchResult(linksText(LINKS.slice(0, 2)))
    assistantSearch()
    searchResult(linksText([LINKS[1], LINKS[2]]))
    success('Searched twice.')
  },
  hang() {
    assistantSearch()
    appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ hanging: process.pid }) + '\n')
    setInterval(() => {}, 1000)
  },
}

let stdin = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => { stdin += chunk })
process.stdin.on('end', () => {
  appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    cwdEntries: readdirSync(process.cwd()),
    systemPrompt: process.argv.includes('--system-prompt-file') ? readFileSync(process.argv[process.argv.indexOf('--system-prompt-file') + 1], 'utf8') : undefined,
    stdin,
  }) + '\n')
  const word = /scenario:(\w+)/.exec(stdin)?.[1] ?? 'success'
  scenarios[word]()
  if (word === 'hang') return
  // Let buffered stdout flush, then end with the scenario's exit code.
  process.stdout.write('', () => process.exit(process.exitCode ?? 0))
})
