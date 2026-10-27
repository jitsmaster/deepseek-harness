/**
 * Source of the tiny stdio MCP server that shows DSH's tool schemas to Claude
 * Code. It answers the MCP handshake and `tools/list`, but `tools/call` is never
 * answered: Claude can only emit a call, never execute one, and DSH's own loop
 * runs the tool after the adapter reports the call. The source is an inline
 * constant because only `lib/index.js` ships (no separate asset file), and runs
 * as `node -e <source> <tools.json>` (script arguments start at `process.argv[1]`).
 * @module @deepseek-ai/dsh-llm-claude-code/stub
 */

/** Plain-JavaScript source of the never-answering MCP server. */
export const STUB_SOURCE = [
  "const fs=require('node:fs'),rl=require('node:readline');",
  "const tools=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));",
  "const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');",
  "rl.createInterface({input:process.stdin}).on('line',l=>{let m;try{m=JSON.parse(l)}catch{return}",
  "if(!m||typeof m!=='object')return;",
  "if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:(m.params&&m.params.protocolVersion)||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'dsh',version:'0.0.1'}}});",
  "else if(m.method==='tools/list')send({jsonrpc:'2.0',id:m.id,result:{tools}});",
  "else if(m.method==='tools/call'){}",
  "else if(m.id!==undefined&&m.method)send({jsonrpc:'2.0',id:m.id,result:{}})",
  "}).on('close',()=>process.exit(0))",
].join('')
