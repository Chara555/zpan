import { type StorageFailureDetails, storageFailureSummary } from '../../../shared/storage-errors'

export function storageRequestError(operation: string, details: StorageFailureDetails, cause?: unknown): Error {
  console.error('storage.request.failed', { operation, ...details })
  const error = new Error(
    `S3 ${operation} failed: ${details.httpStatus ?? 'network'}: ${storageFailureSummary(details)}`,
    { cause },
  )
  error.name = details.code ?? 'StorageRequestError'
  return Object.assign(error, {
    storageDiagnostics: details,
    $metadata: { httpStatusCode: details.httpStatus, requestId: details.requestId },
  })
}
