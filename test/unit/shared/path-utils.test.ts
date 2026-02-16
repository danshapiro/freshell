import { describe, it, expect } from 'vitest'
import { looksLikePath } from '../../../shared/path-utils'

describe('looksLikePath()', () => {
  describe('Unix paths', () => {
    it('should recognize absolute Unix paths', () => {
      expect(looksLikePath('/home/user')).toBe(true)
      expect(looksLikePath('/usr/local/bin')).toBe(true)
      expect(looksLikePath('/var/log/app.log')).toBe(true)
      expect(looksLikePath('/')).toBe(true)
    })

    it('should recognize home directory paths with tilde', () => {
      expect(looksLikePath('~/projects')).toBe(true)
      expect(looksLikePath('~/.config')).toBe(true)
      expect(looksLikePath('~/Documents/file.txt')).toBe(true)
    })

    it('should recognize relative paths', () => {
      expect(looksLikePath('./relative')).toBe(true)
      expect(looksLikePath('../parent')).toBe(true)
      expect(looksLikePath('./src/index.ts')).toBe(true)
      expect(looksLikePath('../../../up/three/levels')).toBe(true)
    })
  })

  describe('Windows paths', () => {
    it('should recognize Windows drive letter paths', () => {
      expect(looksLikePath('C:\\')).toBe(true)
      expect(looksLikePath('C:\\Users')).toBe(true)
      expect(looksLikePath('D:\\Projects')).toBe(true)
      expect(looksLikePath('C:\\Users\\Dan\\Documents')).toBe(true)
    })

    it('should recognize Windows paths with forward slashes', () => {
      expect(looksLikePath('C:/Users')).toBe(true)
      expect(looksLikePath('D:/Projects/app')).toBe(true)
    })

    it('should recognize UNC paths (network shares)', () => {
      expect(looksLikePath('\\\\server\\share')).toBe(true)
      expect(looksLikePath('\\\\192.168.1.1\\folder')).toBe(true)
      expect(looksLikePath('\\\\wsl$\\Ubuntu\\home')).toBe(true)
    })

    it('should recognize Windows relative paths', () => {
      expect(looksLikePath('.\\relative')).toBe(true)
      expect(looksLikePath('..\\parent')).toBe(true)
      expect(looksLikePath('.\\src\\index.ts')).toBe(true)
    })
  })

  describe('non-paths (should return false)', () => {
    it('should reject plain strings without path separators', () => {
      expect(looksLikePath('hello')).toBe(false)
      expect(looksLikePath('project-name')).toBe(false)
      expect(looksLikePath('MyApp')).toBe(false)
      expect(looksLikePath('')).toBe(false)
    })

    it('should reject URLs', () => {
      expect(looksLikePath('https://example.com')).toBe(false)
      expect(looksLikePath('http://localhost:3000')).toBe(false)
      expect(looksLikePath('https://github.com/user/repo')).toBe(false)
      expect(looksLikePath('ftp://files.example.com/doc')).toBe(false)
      expect(looksLikePath('file://localhost/path')).toBe(false)
    })

    it('should reject email addresses', () => {
      expect(looksLikePath('user@example.com')).toBe(false)
    })

    it('should reject strings that look like paths but are protocol-based', () => {
      expect(looksLikePath('s3://bucket/key')).toBe(false)
      expect(looksLikePath('gs://bucket/object')).toBe(false)
      expect(looksLikePath('ssh://user@host/path')).toBe(false)
    })
  })

  describe('edge cases', () => {
    it('should handle paths with spaces', () => {
      expect(looksLikePath('/home/user/My Documents')).toBe(true)
      expect(looksLikePath('C:\\Users\\Dan\\My Documents')).toBe(true)
      expect(looksLikePath('/path/with spaces/file name.txt')).toBe(true)
    })

    it('should handle paths with special characters', () => {
      expect(looksLikePath('/path/with-dashes/file_underscore.ts')).toBe(true)
      expect(looksLikePath('/path/with.dots/file.name.ext')).toBe(true)
      expect(looksLikePath("C:\\path\\with'quotes")).toBe(true)
      expect(looksLikePath('/path/with(parens)/file')).toBe(true)
    })

    it('should handle paths with unicode characters', () => {
      expect(looksLikePath('/home/用户/文档')).toBe(true)
      expect(looksLikePath('C:\\Users\\José\\Documents')).toBe(true)
    })

    it('should handle root-only paths', () => {
      expect(looksLikePath('/')).toBe(true)
      expect(looksLikePath('C:\\')).toBe(true)
    })

    it('should handle tilde alone (home directory)', () => {
      expect(looksLikePath('~')).toBe(true)
    })

    it('should handle dot alone (current directory)', () => {
      expect(looksLikePath('.')).toBe(true)
    })

    it('should handle double dot alone (parent directory)', () => {
      expect(looksLikePath('..')).toBe(true)
    })
  })
})
