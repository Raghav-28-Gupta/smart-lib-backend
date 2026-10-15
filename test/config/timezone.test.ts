import { describe, expect, it } from 'vitest'
import { timeZoneWarning } from '../../src/config/timezone'

describe('timeZoneWarning', () => {
  it('warns when production runs without TZ', () => {
    expect(timeZoneWarning({ NODE_ENV: 'production' })).toMatch(/TZ is not set/)
  })

  it('is silent when production sets TZ', () => {
    expect(timeZoneWarning({ NODE_ENV: 'production', TZ: 'Asia/Kolkata' })).toBeNull()
  })

  it('is silent outside production, where the machine already uses local time', () => {
    expect(timeZoneWarning({ NODE_ENV: 'development' })).toBeNull()
    expect(timeZoneWarning({})).toBeNull()
  })
})
