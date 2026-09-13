/**
 * Four-quadrant RPC message model (vendored legacy contract).
 * @module @deepseek-ai/dsh-host-apiproxy/api/rpc
 */

/** Brands a string as RpcId (compile-time cast, zero runtime cost). */
export declare function RpcId(id: string): string
/** Fold a transport exception into the RpcResult error branch. */
export declare function transportError(error: unknown): {
  ok: false
  error: { code: 'internal'; message: string; details: {} }
}
