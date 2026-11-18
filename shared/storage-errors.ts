// Storage diagnostics are an allowlist, never a raw response, request, or SDK error.
export interface StorageFailureDetails {
  httpStatus?: number
  code?: string
  requestId?: string
}
function identifier(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max && /^[A-Za-z0-9_+/.=-]+$/.test(value) ? value : undefined
}
export function storageFailureDetails(error: unknown): StorageFailureDetails {
  const data = (error ?? {}) as {
    name?: unknown
    Code?: unknown
    code?: unknown
    $metadata?: { httpStatusCode?: unknown; requestId?: unknown }
    $response?: { statusCode?: unknown; headers?: Record<string, unknown> }
  }
  const status = data.$metadata?.httpStatusCode ?? data.$response?.statusCode
  return {
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? { httpStatus: status }
      : {}),
    code: identifier(data.Code ?? data.code ?? data.name, 128),
    requestId: identifier(
      data.$metadata?.requestId ??
        data.$response?.headers?.['x-oss-request-id'] ??
        data.$response?.headers?.['x-amz-request-id'],
      256,
    ),
  }
}
export function storageResponseDetails(status: number, headers: Headers, body = ''): StorageFailureDetails {
  // Extract only two bounded identifiers. Do not retain Message, StringToSign,
  // AccessKeyId, CanonicalRequest, signed URLs or arbitrary response headers.
  const xml = body.slice(0, 32_768)
  return storageFailureDetails({
    Code: /<Code>\s*([^<]*)\s*<\/Code>/.exec(xml)?.[1].trim(),
    $metadata: {
      httpStatusCode: status,
      requestId:
        headers.get('x-oss-request-id') ??
        headers.get('x-amz-request-id') ??
        /<RequestId>\s*([^<]*)\s*<\/RequestId>/.exec(xml)?.[1].trim(),
    },
  })
}
export function storageFailureSummary(details: StorageFailureDetails): string {
  return [
    details.httpStatus ? `HTTP ${details.httpStatus}` : undefined,
    details.code,
    details.requestId ? `RequestId ${details.requestId}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}
