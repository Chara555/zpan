import { describe, expect, it, vi } from 'vitest'
import { formatError } from '../../lib/errors'
import { storageRequestError } from './storage-errors'

describe('storage error logging boundary', () => {
  it('retains the raw cause for recovery but never flattens it into logs', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const raw = new Error('Authorization: secret https://oss.test/?X-Amz-Signature=secret')
      const error = storageRequestError(
        'DeleteObjectCommand',
        { httpStatus: 403, code: 'AccessDenied', requestId: 'oss-id' },
        raw,
      )
      expect(error.cause).toBe(raw)
      expect(formatError(error)).toContain('AccessDenied')
      expect(formatError(new Error('outer', { cause: error }))).not.toContain('secret')
      expect(formatError(error)).not.toContain('secret')
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/Authorization|X-Amz|secret/)
    } finally {
      log.mockRestore()
    }
  })
})
