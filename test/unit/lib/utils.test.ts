import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { cn, isMacLike, shallowEqual } from '../../../src/lib/utils'

describe('utils', () => {
  describe('cn (classNames)', () => {
    it('joins multiple class strings', () => {
      expect(cn('foo', 'bar', 'baz')).toBe('foo bar baz')
    })

    it('filters out false values', () => {
      expect(cn('foo', false, 'bar')).toBe('foo bar')
    })

    it('filters out null values', () => {
      expect(cn('foo', null, 'bar')).toBe('foo bar')
    })

    it('filters out undefined values', () => {
      expect(cn('foo', undefined, 'bar')).toBe('foo bar')
    })

    it('handles empty string values', () => {
      // Empty strings are falsy, so they should be filtered
      expect(cn('foo', '', 'bar')).toBe('foo bar')
    })

    it('handles all falsy values', () => {
      expect(cn(false, null, undefined, '')).toBe('')
    })

    it('returns empty string for no arguments', () => {
      expect(cn()).toBe('')
    })

    it('returns single class when only one valid class provided', () => {
      expect(cn('single')).toBe('single')
    })

    it('handles conditional classes pattern', () => {
      const isActive = true
      const isDisabled = false
      expect(cn('base', isActive && 'active', isDisabled && 'disabled')).toBe('base active')
    })

    it('handles complex conditional expressions', () => {
      const state = 'loading'
      expect(cn(
        'btn',
        state === 'loading' && 'btn-loading',
        state === 'error' && 'btn-error',
        state === 'success' && 'btn-success'
      )).toBe('btn btn-loading')
    })

    it('preserves whitespace in individual class names', () => {
      // Not recommended usage, but tests actual behavior
      expect(cn('foo bar', 'baz')).toBe('foo bar baz')
    })
  })

  describe('isMacLike', () => {
    let originalNavigator: PropertyDescriptor | undefined

    beforeEach(() => {
      // Save original navigator descriptor
      originalNavigator = Object.getOwnPropertyDescriptor(global, 'navigator')
    })

    afterEach(() => {
      // Restore original navigator
      if (originalNavigator) {
        Object.defineProperty(global, 'navigator', originalNavigator)
      } else {
        // If navigator was undefined, remove it
        delete (global as any).navigator
      }
    })

    it('returns true for Mac platform', () => {
      Object.defineProperty(global, 'navigator', {
        value: { platform: 'MacIntel' },
        writable: true,
        configurable: true,
      })
      expect(isMacLike()).toBe(true)
    })

    it('returns true for iPhone platform', () => {
      Object.defineProperty(global, 'navigator', {
        value: { platform: 'iPhone' },
        writable: true,
        configurable: true,
      })
      expect(isMacLike()).toBe(true)
    })

    it('returns true for iPad platform', () => {
      Object.defineProperty(global, 'navigator', {
        value: { platform: 'iPad' },
        writable: true,
        configurable: true,
      })
      expect(isMacLike()).toBe(true)
    })

    it('returns true for iPod platform', () => {
      Object.defineProperty(global, 'navigator', {
        value: { platform: 'iPod' },
        writable: true,
        configurable: true,
      })
      expect(isMacLike()).toBe(true)
    })

    it('returns false for Windows platform', () => {
      Object.defineProperty(global, 'navigator', {
        value: { platform: 'Win32' },
        writable: true,
        configurable: true,
      })
      expect(isMacLike()).toBe(false)
    })

    it('returns false for Linux platform', () => {
      Object.defineProperty(global, 'navigator', {
        value: { platform: 'Linux x86_64' },
        writable: true,
        configurable: true,
      })
      expect(isMacLike()).toBe(false)
    })

    it('returns false for Android platform', () => {
      Object.defineProperty(global, 'navigator', {
        value: { platform: 'Linux armv7l' },
        writable: true,
        configurable: true,
      })
      expect(isMacLike()).toBe(false)
    })

    it('handles platform containing Mac anywhere', () => {
      Object.defineProperty(global, 'navigator', {
        value: { platform: 'SomeMacPlatform' },
        writable: true,
        configurable: true,
      })
      expect(isMacLike()).toBe(true)
    })
  })

  describe('shallowEqual', () => {
    describe('identical references', () => {
      it('returns true for same object reference', () => {
        const obj = { a: 1, b: 2 }
        expect(shallowEqual(obj, obj)).toBe(true)
      })

      it('returns true for same array reference', () => {
        const arr = [1, 2, 3]
        expect(shallowEqual(arr, arr)).toBe(true)
      })

      it('returns true for same primitive value', () => {
        expect(shallowEqual(5, 5)).toBe(true)
        expect(shallowEqual('hello', 'hello')).toBe(true)
        expect(shallowEqual(true, true)).toBe(true)
      })

      it('returns true for both null', () => {
        expect(shallowEqual(null, null)).toBe(true)
      })

      it('returns true for both undefined', () => {
        expect(shallowEqual(undefined, undefined)).toBe(true)
      })
    })

    describe('null/undefined handling', () => {
      it('returns false when first is null', () => {
        expect(shallowEqual(null, { a: 1 })).toBe(false)
      })

      it('returns false when second is null', () => {
        expect(shallowEqual({ a: 1 }, null)).toBe(false)
      })

      it('returns false when first is undefined', () => {
        expect(shallowEqual(undefined, { a: 1 })).toBe(false)
      })

      it('returns false when second is undefined', () => {
        expect(shallowEqual({ a: 1 }, undefined)).toBe(false)
      })

      it('returns false for null vs undefined', () => {
        expect(shallowEqual(null, undefined)).toBe(false)
      })

      it('returns false for undefined vs null', () => {
        expect(shallowEqual(undefined, null)).toBe(false)
      })
    })

    describe('object comparison', () => {
      it('returns true for equal objects with same keys', () => {
        expect(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true)
      })

      it('returns false for objects with different values', () => {
        expect(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 3 })).toBe(false)
      })

      it('returns false for objects with different number of keys', () => {
        expect(shallowEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false)
        expect(shallowEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
      })

      it('returns false for objects with different keys', () => {
        expect(shallowEqual({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false)
      })

      it('returns true for empty objects', () => {
        expect(shallowEqual({}, {})).toBe(true)
      })

      it('performs shallow comparison (not deep)', () => {
        const nested1 = { a: { b: 1 } }
        const nested2 = { a: { b: 1 } }
        // Different object references for nested object, so shallow compare fails
        expect(shallowEqual(nested1, nested2)).toBe(false)
      })

      it('returns true for same nested object reference', () => {
        const inner = { b: 1 }
        expect(shallowEqual({ a: inner }, { a: inner })).toBe(true)
      })
    })

    describe('array comparison', () => {
      it('compares arrays by index as object keys', () => {
        // Arrays are objects, so they get compared by enumerable properties
        expect(shallowEqual([1, 2, 3], [1, 2, 3])).toBe(true)
      })

      it('returns false for arrays with different values', () => {
        expect(shallowEqual([1, 2, 3], [1, 2, 4])).toBe(false)
      })

      it('returns false for arrays with different lengths', () => {
        expect(shallowEqual([1, 2], [1, 2, 3])).toBe(false)
      })

      it('returns true for empty arrays', () => {
        expect(shallowEqual([], [])).toBe(true)
      })
    })

    describe('edge cases', () => {
      it('handles objects with numeric keys', () => {
        expect(shallowEqual({ 1: 'a', 2: 'b' }, { 1: 'a', 2: 'b' })).toBe(true)
      })

      it('handles objects with special string keys', () => {
        expect(shallowEqual(
          { 'key-with-dash': 1, 'key.with.dot': 2 },
          { 'key-with-dash': 1, 'key.with.dot': 2 }
        )).toBe(true)
      })

      it('handles objects with undefined values', () => {
        expect(shallowEqual({ a: undefined }, { a: undefined })).toBe(true)
      })

      it('handles objects with null values', () => {
        expect(shallowEqual({ a: null }, { a: null })).toBe(true)
      })

      it('differentiates between missing key and undefined value', () => {
        // Object with key 'a' set to undefined vs object without key 'a'
        const withUndefined = { a: undefined }
        const withoutKey = {}
        expect(shallowEqual(withUndefined, withoutKey)).toBe(false)
      })

      it('handles objects with function values', () => {
        const fn = () => {}
        expect(shallowEqual({ fn }, { fn })).toBe(true)
        expect(shallowEqual({ fn: () => {} }, { fn: () => {} })).toBe(false)
      })

      it('handles objects with Date values', () => {
        const date = new Date('2024-01-01')
        expect(shallowEqual({ d: date }, { d: date })).toBe(true)
        // Different Date instances with same value are not equal (shallow comparison)
        expect(shallowEqual(
          { d: new Date('2024-01-01') },
          { d: new Date('2024-01-01') }
        )).toBe(false)
      })

      it('handles objects with array values', () => {
        const arr = [1, 2, 3]
        expect(shallowEqual({ arr }, { arr })).toBe(true)
        // Different array instances are not equal (shallow comparison)
        expect(shallowEqual({ arr: [1, 2] }, { arr: [1, 2] })).toBe(false)
      })
    })
  })
})
