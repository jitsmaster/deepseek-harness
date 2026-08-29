/**
 * apiproxy contract-layer barrel (vendored legacy contract).
 * api/ has zero Node dependencies and is importable from the browser.
 * @module @deepseek-ai/dsh-host-apiproxy/api
 */

export { RpcId, transportError } from './rpc.js'
export {
  clientRequestSchema, serverRequestSchema, serverResponseSchema,
  clientResponseSchema, rpcIdSchema, rpcErrorSchema, rpcResultSchema,
  rpcMessageSchema, rpcReceiptSchema,
} from './rpc.schema.js'
export { SESSION_SEARCH_RESULT_LIMIT, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS } from './session-search.js'
export { askUserQuestionItemSchema, muxFrameSchema, hostFrameSchema } from './events.schema.js'
export { approvalRequestIdSchema, approvalResponsePayloadSchema } from './approvals.schema.js'
export { taskIdSchema, taskViewSchema } from './jobs.schema.js'
export { workspaceViewSchema, workspaceListRequestSchema } from './workspace.schema.js'
