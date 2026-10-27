import { describe, expect, it } from 'vitest'
import type { ClaudeAccountView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  formatPercent, isPlausibleEmail, leastUsedEmail, normalizeEmail, peakUtilization, spanOf,
} from '../src/client/accounts-model.ts'

const window = (utilization: number): { utilization: number; resetsAt: number } => ({ utilization, resetsAt: 1_800_000_000 })

function account(email: string, fiveHour?: number, sevenDay?: number, signedIn = true): ClaudeAccountView {
  const usage = fiveHour === undefined && sevenDay === undefined
    ? undefined
    : {
      updatedAt: 1,
      ...fiveHour === undefined ? {} : { fiveHour: window(fiveHour) },
      ...sevenDay === undefined ? {} : { sevenDay: window(sevenDay) },
    }
  return { email, id: email, signedIn, active: false, ...usage === undefined ? {} : { usage } }
}

describe('email rules', () => {
  it('normalizes by trimming and lowercasing', () => {
    expect(normalizeEmail('  Me@X.COM ')).toBe('me@x.com')
  })

  it('accepts a dotted domain and rejects spaces, a missing part, and a leading dash', () => {
    expect(isPlausibleEmail(' me@x.com ')).toBe(true)
    for (const bad of ['', 'me', 'me@x', 'me@@x.com', 'm e@x.com', '-me@x.com', '@x.com', 'me@.com']) {
      expect(isPlausibleEmail(bad), bad).toBe(false)
    }
  })
})

describe('usage ranking', () => {
  it('takes the larger window as an account peak, and none without a reading', () => {
    expect(peakUtilization(account('a@x.com', 0.2, 0.7).usage)).toBe(0.7)
    expect(peakUtilization(account('a@x.com', 0.4).usage)).toBe(0.4)
    expect(peakUtilization(undefined)).toBeUndefined()
    expect(peakUtilization({ updatedAt: 1 })).toBeUndefined()
  })

  it('names the signed-in account with the lowest peak', () => {
    expect(leastUsedEmail([account('a@x.com', 0.1, 0.9), account('b@x.com', 0.5, 0.5), account('c@x.com', 0.6, 0.3)])).toBe('b@x.com')
  })

  it('breaks a tie on the weekly window', () => {
    expect(leastUsedEmail([account('a@x.com', 0.5, 0.5), account('b@x.com', 0.5, 0.2)])).toBe('b@x.com')
    expect(leastUsedEmail([account('a@x.com', 0.5), account('b@x.com', 0.5, 0.2)])).toBe('a@x.com')
  })

  it('ignores accounts that are not signed in or have no reading', () => {
    expect(leastUsedEmail([account('a@x.com', 0.9, 0.9), account('b@x.com', 0.1, 0.1, false), account('c@x.com')])).toBeUndefined()
    expect(leastUsedEmail([account('a@x.com', 0.9, 0.9), account('b@x.com', 0.1, 0.1, false), account('c@x.com', 0.3, 0.3)])).toBe('c@x.com')
  })

  it('names nobody when fewer than two accounts can be compared', () => {
    expect(leastUsedEmail([])).toBeUndefined()
    expect(leastUsedEmail([account('a@x.com', 0.1, 0.1)])).toBeUndefined()
  })
})

describe('reading usage', () => {
  it('formats a fraction as a clamped whole percent', () => {
    expect([0, 0.426, 1, 1.4, -0.2].map(formatPercent)).toEqual(['0%', '43%', '100%', '100%', '0%'])
  })

  it('rounds a duration to its largest whole unit', () => {
    expect(spanOf(-5)).toEqual({ unit: 'seconds', count: 0 })
    expect(spanOf(59_999)).toEqual({ unit: 'seconds', count: 59 })
    expect(spanOf(61_000)).toEqual({ unit: 'minutes', count: 1 })
    expect(spanOf(3_600_000 * 5)).toEqual({ unit: 'hours', count: 5 })
    expect(spanOf(3_600_000 * 47)).toEqual({ unit: 'hours', count: 47 })
    expect(spanOf(3_600_000 * 72)).toEqual({ unit: 'days', count: 3 })
  })
})
