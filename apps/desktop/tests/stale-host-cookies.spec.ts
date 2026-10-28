import { expect, it, vi } from 'vitest'
import { clearStaleHostCookies, type HostCookieJar } from '../src/stale-host-cookies.ts'

type Cookie = Awaited<ReturnType<HostCookieJar['get']>>[number]

const cookie = (name: string, extra: { [K in keyof Cookie]?: Cookie[K] | undefined } = {}): Cookie => ({
  name, value: 'v', domain: '127.0.0.1', path: '/', secure: false, ...extra,
}) as Cookie

function jar(cookies: Cookie[]) {
  return {
    get: vi.fn(async () => cookies),
    remove: vi.fn(async (_url: string, _name: string) => undefined),
  }
}

it('removes every Host auth cookie left on the loopback hosts by earlier launches', async () => {
  const cookies = jar([
    cookie('dsh-auth-aaa'), cookie('dsh-auth-bbb'), cookie('dsh-auth-ccc', { domain: 'localhost' }),
    cookie('dsh-auth-ddd', { domain: '.localhost' }),
  ])
  expect(await clearStaleHostCookies(cookies)).toBe(4)
  expect(cookies.remove.mock.calls).toEqual([
    ['http://127.0.0.1/', 'dsh-auth-aaa'], ['http://127.0.0.1/', 'dsh-auth-bbb'],
    ['http://localhost/', 'dsh-auth-ccc'], ['http://localhost/', 'dsh-auth-ddd'],
  ])
})

it('leaves cookies that are not Host auth cookies, or belong to other hosts', async () => {
  const cookies = jar([
    cookie('session'), cookie('dsh-auth'), cookie('xdsh-auth-aaa'),
    cookie('dsh-auth-aaa', { domain: 'example.com' }), cookie('dsh-auth-bbb', { domain: 'notlocalhost' }),
  ])
  expect(await clearStaleHostCookies(cookies)).toBe(0)
  expect(cookies.remove).not.toHaveBeenCalled()
})

it('addresses each cookie by its own path and scheme so the removal matches it', async () => {
  const cookies = jar([cookie('dsh-auth-aaa', { path: '/app', secure: true })])
  await clearStaleHostCookies(cookies)
  expect(cookies.remove).toHaveBeenCalledWith('https://127.0.0.1/app', 'dsh-auth-aaa')
})

it('matches the loopback host case-insensitively, defaults a missing path, and skips a cookie with no domain', async () => {
  const cookies = jar([
    cookie('dsh-auth-aaa', { domain: 'LOCALHOST' }),
    cookie('dsh-auth-bbb', { path: undefined }),
    cookie('dsh-auth-ccc', { domain: undefined }),
  ])
  expect(await clearStaleHostCookies(cookies)).toBe(2)
  expect(cookies.remove.mock.calls).toEqual([
    ['http://localhost/', 'dsh-auth-aaa'], ['http://127.0.0.1/', 'dsh-auth-bbb'],
  ])
})

it('keeps sweeping after one removal fails and counts only the removed cookies', async () => {
  const cookies = jar([cookie('dsh-auth-aaa'), cookie('dsh-auth-bbb'), cookie('dsh-auth-ccc')])
  cookies.remove.mockRejectedValueOnce(new Error('remove failed'))
  expect(await clearStaleHostCookies(cookies)).toBe(2)
  expect(cookies.remove).toHaveBeenCalledTimes(3)
})

it('never throws when the cookie jar cannot be read: startup must not depend on the sweep', async () => {
  const cookies = jar([])
  cookies.get.mockRejectedValueOnce(new Error('jar unavailable'))
  await expect(clearStaleHostCookies(cookies)).resolves.toBe(0)
  expect(cookies.remove).not.toHaveBeenCalled()
})
