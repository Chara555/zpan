import { afterEach, describe, expect, it, vi } from 'vitest'
import { S3Service, type S3StorageCredentials } from '../server/adapters/gateways/s3'

const storage: S3StorageCredentials = {
  bucket: 'oss-contract-bucket',
  endpoint: 'https://s3.oss-cn-beijing.aliyuncs.com',
  region: 'cn-beijing',
  accessKey: 'test-access-key',
  secretKey: 'test-secret-key',
  forcePathStyle: false,
}
const service = new S3Service()
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('OSS in Workers using the real S3 SDK', () => {
  it('presigns PUT, GET and multipart parts with the same virtual host', async () => {
    const urls = await Promise.all([
      service.presignUpload(storage, 'folder/test.txt', 'text/plain'),
      service.presignDownload(storage, 'folder/test.txt', 'test.txt'),
      service.presignUploadPart(storage, 'folder/test.txt', 'upload-id', 1),
    ])
    for (const value of urls) {
      const url = new URL(value)
      expect(url.hostname).toBe('oss-contract-bucket.s3.oss-cn-beijing.aliyuncs.com')
      expect(url.pathname).toBe('/folder/test.txt')
      expect(url.searchParams.has('X-Amz-Signature')).toBe(true)
    }
  })
  it('parses OSS XML errors without DOMParser and retains safe metadata', async () => {
    expect(typeof DOMParser).toBe('undefined')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            '<Error><Code>AccessDenied</Code><Message>denied</Message><RequestId>oss-request-1</RequestId></Error>',
            { status: 403, headers: { 'content-type': 'application/xml', 'x-oss-request-id': 'oss-request-1' } },
          ),
      ),
    )
    await expect(service.deleteObject(storage, 'folder/test.txt')).rejects.toMatchObject({
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403, requestId: 'oss-request-1' },
    })
  })
  it('uses virtual host for deletion, multipart create, completion and abort', async () => {
    const requests: { host: string; path: string; method: string }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        requests.push({ host: url.hostname, path: url.pathname, method: request.method })
        if (request.method === 'POST' && url.searchParams.has('uploads'))
          return new Response(
            '<InitiateMultipartUploadResult><UploadId>upload-id</UploadId></InitiateMultipartUploadResult>',
          )
        if (request.method === 'POST')
          return new Response('<CompleteMultipartUploadResult><ETag>etag</ETag></CompleteMultipartUploadResult>')
        return new Response(null, { status: 204 })
      }),
    )
    const id = await service.createMultipartUpload(storage, 'folder/test.txt', 'text/plain')
    expect(id).toBe('upload-id')
    await service.completeMultipartUpload(storage, 'folder/test.txt', id, [{ etag: 'etag', partNumber: 1 }])
    await service.abortMultipartUpload(storage, 'folder/test.txt', id)
    await service.deleteObject(storage, 'folder/test.txt')
    expect(requests).toHaveLength(4)
    for (const request of requests) {
      expect(request.host).toBe('oss-contract-bucket.s3.oss-cn-beijing.aliyuncs.com')
      expect(request.path).toBe('/folder/test.txt')
    }
  })
  it('executes presigned PUT/GET, SDK delete, and a streamed multipart upload against an OSS-shaped transport', async () => {
    let object: Uint8Array | undefined
    const parts: Uint8Array[] = []
    let multipartStarted = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init)
        const url = new URL(request.url)
        expect(url.hostname).toBe('oss-contract-bucket.s3.oss-cn-beijing.aliyuncs.com')
        expect(url.pathname).toBe('/test.bin')
        if (request.method === 'POST' && url.searchParams.has('uploads')) {
          multipartStarted = true
          return new Response(
            '<InitiateMultipartUploadResult><UploadId>stream-upload</UploadId></InitiateMultipartUploadResult>',
          )
        }
        if (request.method === 'PUT' && url.searchParams.has('uploadId')) {
          parts.push(new Uint8Array(await request.arrayBuffer()))
          return new Response(null, { headers: { ETag: `"part-${parts.length}"` } })
        }
        if (request.method === 'POST' && url.searchParams.has('uploadId')) {
          const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
          let offset = 0
          for (const part of parts) {
            bytes.set(part, offset)
            offset += part.length
          }
          object = bytes
          return new Response(
            '<CompleteMultipartUploadResult><ETag>complete-etag</ETag></CompleteMultipartUploadResult>',
          )
        }
        if (request.method === 'PUT') {
          object = new Uint8Array(await request.arrayBuffer())
          return new Response(null)
        }
        if (request.method === 'DELETE') {
          object = undefined
          return new Response(null, { status: 204 })
        }
        return object ? new Response(object) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
      }),
    )
    const put = await service.presignUpload(storage, 'test.bin', 'application/octet-stream')
    expect((await fetch(put, { method: 'PUT', body: new Uint8Array([1, 2, 3]) })).ok).toBe(true)
    const get = await service.presignDownload(storage, 'test.bin', 'test.bin')
    expect(new Uint8Array(await (await fetch(get)).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
    await service.deleteObject(storage, 'test.bin')
    expect(object).toBeUndefined()
    const data = new Uint8Array(5 * 1024 * 1024 + 3).fill(7)
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(data)
        c.close()
      },
    })
    expect(await service.putObject(storage, 'test.bin', stream, 'application/octet-stream')).toBe(data.length)
    expect(multipartStarted).toBe(true)
    expect(parts).toHaveLength(2)
    const downloaded = await service.getObjectBytes(storage, 'test.bin')
    expect(downloaded.byteLength).toBe(data.byteLength)
    expect(await crypto.subtle.digest('SHA-256', downloaded)).toEqual(await crypto.subtle.digest('SHA-256', data))
    await service.deleteObject(storage, 'test.bin')
    expect(object).toBeUndefined()
  })
})
