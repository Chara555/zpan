import { describe, expect, it } from 'vitest'
import { storageFailureDetails, storageFailureSummary, storageResponseDetails } from './storage-errors'

describe('allowlisted storage diagnostics', () => {
  it('keeps only status, storage code and RequestId', () => {
    const error = {
      name: 'AccessDenied',
      message: 'SECRET https://signed.test',
      Authorization: 'secret',
      $metadata: { httpStatusCode: 403, requestId: 'id-1' },
    }
    expect(storageFailureDetails(error)).toEqual({ httpStatus: 403, code: 'AccessDenied', requestId: 'id-1' })
    expect(storageFailureSummary(storageFailureDetails(error))).toBe('HTTP 403 · AccessDenied · RequestId id-1')
  })
  it('keeps OSS RequestId from a bodyless SDK HEAD error without retaining other headers', () => {
    const details = storageFailureDetails({
      name: 'Forbidden',
      $metadata: { httpStatusCode: 403 },
      $response: { statusCode: 403, headers: { 'x-oss-request-id': 'head-request-id', authorization: 'SECRET' } },
    })
    expect(details).toEqual({ httpStatus: 403, code: 'Forbidden', requestId: 'head-request-id' })
    expect(JSON.stringify(details)).not.toContain('SECRET')
  })

  it('extracts OSS XML identifiers and prefers response headers', () => {
    expect(
      storageResponseDetails(
        403,
        new Headers({ 'x-oss-request-id': 'header-id' }),
        '<Error><Code>AccessDenied</Code><RequestId>xml-id</RequestId></Error>',
      ),
    ).toEqual({ httpStatus: 403, code: 'AccessDenied', requestId: 'header-id' })
    expect(
      storageResponseDetails(
        400,
        new Headers(),
        '<Error><Code>InvalidPart</Code><RequestId>xml-id</RequestId></Error>',
      ),
    ).toEqual({ httpStatus: 400, code: 'InvalidPart', requestId: 'xml-id' })
  })
  it('decodes only allowlisted identifiers from bodyless OSS HEAD errors', () => {
    const encoded = btoa(
      '<Error><Code>AccessDenied</Code><EC>0003-00000501</EC><Message>SECRET signed URL</Message><StringToSign>SECRET</StringToSign></Error>',
    )
    const details = storageResponseDetails(
      403,
      new Headers({ 'x-oss-err': encoded, 'x-oss-ec': '0003-00000501', 'x-oss-request-id': 'head-id' }),
    )
    expect(details).toEqual({
      httpStatus: 403,
      code: 'AccessDenied',
      requestId: 'head-id',
      providerCode: '0003-00000501',
    })
    expect(storageFailureSummary(details)).toContain('OSS EC 0003-00000501')
    expect(JSON.stringify(details)).not.toContain('SECRET')
    const wrapped = Object.assign(new Error('safe'), {
      name: 'AccessDenied',
      storageDiagnostics: details,
      $metadata: { httpStatusCode: 403, requestId: 'head-id' },
    })
    expect(storageFailureDetails(wrapped)).toEqual(details)
  })

  it('keeps status and request id when optional OSS error headers are malformed', () => {
    expect(
      storageResponseDetails(403, new Headers({ 'x-oss-err': 'not-base64!!!', 'x-oss-request-id': 'head-id' })),
    ).toEqual({ httpStatus: 403, code: undefined, requestId: 'head-id' })
  })

  it('rejects URL, CRLF and unbounded values in identifier fields', () => {
    expect(
      storageFailureDetails({
        Code: 'https://signed.test/?X-Amz-Signature=secret',
        $metadata: { httpStatusCode: 999, requestId: 'id\r\nAuthorization: secret' },
      }),
    ).toEqual({ code: undefined, requestId: undefined })
    expect(storageFailureDetails({ name: 'a'.repeat(129) }).code).toBeUndefined()
    expect(storageFailureDetails(null)).toEqual({ code: undefined, requestId: undefined })
  })
})
