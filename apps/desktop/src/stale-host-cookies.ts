/** Removal of Host auth cookies that earlier launches left in the shell's persistent cookie jar. */

/** Cookie fields the sweep reads; Electron's `Cookie` satisfies it. */
export interface HostCookie {
  readonly name: string
  readonly domain?: string
  readonly path?: string
  readonly secure?: boolean
}

/** The part of Electron's `session.cookies` the sweep needs. */
export interface HostCookieJar {
  get(filter: { name?: string }): Promise<readonly HostCookie[]>
  remove(url: string, name: string): Promise<void>
}

/** Prefix of the Host's browser-session cookie (`packages/client/connection/src/browser-auth.ts`). */
const AUTH_COOKIE_PREFIX = 'dsh-auth-'
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost'])

function removalUrl(cookie: HostCookie, host: string): string {
  return `${cookie.secure === true ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`
}

/**
 * Remove every Host auth cookie stored for the loopback hosts.
 *
 * The Host names its cookie after its authority, which includes the port. Each Desktop launch binds
 * a new port, so each launch stores a differently named cookie, and cookies are not port-scoped:
 * the old ones accumulate and ride along on every later request until the Host answers 431. A
 * launch mints its own cookie afterwards, so none of the removed cookies is still needed.
 * Best effort: a failure never blocks startup.
 * @param cookies - Electron session cookie jar.
 * @returns Number of cookies removed.
 */
export async function clearStaleHostCookies(cookies: HostCookieJar): Promise<number> {
  let stored: readonly HostCookie[]
  try { stored = await cookies.get({}) } catch { return 0 }
  let removed = 0
  for (const cookie of stored) {
    if (!cookie.name.startsWith(AUTH_COOKIE_PREFIX)) continue
    const host = (cookie.domain ?? '').replace(/^\./u, '').toLowerCase()
    if (!LOOPBACK_HOSTS.has(host)) continue
    try {
      await cookies.remove(removalUrl(cookie, host), cookie.name)
      removed += 1
    } catch { /* keep sweeping; a cookie that cannot be removed only costs header size */ }
  }
  return removed
}
