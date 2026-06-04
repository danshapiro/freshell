import { describe, it, expect } from 'vitest'
import {
  isFinalizedTitleSource,
  canUpgradeTitle,
  titleSourceRank,
  type TitleSource,
} from '@shared/title-source'

const FINALIZED: TitleSource[] = ['user', 'ai', 'first-message', 'legacy']

describe('title-source ladder', () => {
  describe('isFinalizedTitleSource', () => {
    it('treats the dir placeholder and absence as NOT finalized', () => {
      expect(isFinalizedTitleSource('dir')).toBe(false)
      expect(isFinalizedTitleSource(undefined)).toBe(false)
    })

    it('treats user / ai / first-message / legacy as finalized', () => {
      for (const source of FINALIZED) {
        expect(isFinalizedTitleSource(source)).toBe(true)
      }
    })
  })

  describe('titleSourceRank precedence', () => {
    it('orders user > ai > first-message > legacy > dir > none', () => {
      expect(titleSourceRank('user')).toBeGreaterThan(titleSourceRank('ai'))
      expect(titleSourceRank('ai')).toBeGreaterThan(titleSourceRank('first-message'))
      expect(titleSourceRank('first-message')).toBeGreaterThan(titleSourceRank('legacy'))
      expect(titleSourceRank('legacy')).toBeGreaterThan(titleSourceRank('dir'))
      expect(titleSourceRank('dir')).toBeGreaterThan(titleSourceRank(undefined))
    })
  })

  describe('canUpgradeTitle', () => {
    it('lets an auto source replace the unfinalized dir placeholder', () => {
      expect(canUpgradeTitle('dir', 'first-message')).toBe(true)
      expect(canUpgradeTitle('dir', 'ai')).toBe(true)
      expect(canUpgradeTitle(undefined, 'dir')).toBe(true)
    })

    it('refuses to downgrade or auto-overwrite a finalized name', () => {
      expect(canUpgradeTitle('first-message', 'dir')).toBe(false)
      expect(canUpgradeTitle('ai', 'first-message')).toBe(false)
      expect(canUpgradeTitle('legacy', 'first-message')).toBe(false)
      expect(canUpgradeTitle('user', 'ai')).toBe(false)
    })

    it('always lets an explicit user rename win, including re-renaming a user name', () => {
      expect(canUpgradeTitle('first-message', 'user')).toBe(true)
      expect(canUpgradeTitle('legacy', 'user')).toBe(true)
      expect(canUpgradeTitle('ai', 'user')).toBe(true)
      expect(canUpgradeTitle('user', 'user')).toBe(true)
    })
  })
})
