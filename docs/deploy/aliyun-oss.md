# Alibaba Cloud OSS on Workers

Use the regional **S3** endpoint, for example
`https://s3.oss-cn-beijing.aliyuncs.com`, region `cn-beijing`, and disable
**Path-style addressing**. Save the form before testing. The bucket must not be
included in the Endpoint field. For bucket `example`, SDK signing uses
`https://example.s3.oss-cn-beijing.aliyuncs.com/<key>`.

The checkbox is persisted through create/replace/patch and read back into the
same `S3Client` configuration used by PUT, GET, HEAD, DELETE, and multipart
operations. It is not hardcoded true in the client. Changing Endpoint alone
previously retained the old true value. Entering a recognized OSS S3 endpoint
now defaults the form to virtual-hosted addressing. Existing stored settings
remain explicit: turn off Path-style addressing and save existing OSS entries.
Never rewrite a signed URL afterwards; host and path participate in its signature.

## Workers XML compatibility

Workers has no `DOMParser`. The SDK's browser condition selects
`@aws-sdk/xml-builder/dist-es/xml-parser.browser.js`; error responses on even
single-object operations can use this parser. A successful PUT/DELETE is not
proof that error deserialization works.

`wrangler.toml` and the Vite root resolver explicitly select the XML package's
non-browser CommonJS entry. The package is a direct, pinned dependency using the
version already in the lockfile. Workers tests use the same entry and prebundle
it to handle the test runner's CJS/ESM loader. Production deployment checks reject
an artifact containing the browser XML parser.

## Failure diagnostics

Server-side SDK/fetch failures log `storage.request.failed` with operation,
HTTP status, storage error code, and RequestId only. They reject the operation.
Raw XML, Message, CanonicalRequest, StringToSign, request headers, credentials,
and signed URLs are never logged. SDK causes remain available in memory, but
the generic error formatter stops at the safe storage-error boundary.

The browser test keeps upload and strict cleanup failures separately. Readable
upload failures extract only status/code/RequestId and report them through the
existing authorized abort-upload request. The server logs these as
`storage.upload.failed` with `source: browser` **before** attempting cleanup.
These are untrusted client diagnostics, not proof of the storage response.
If CORS blocks access, only `BrowserNetworkError` is available; no HTTP status or
storage code is invented. Exposing `ETag` and `x-oss-request-id` in bucket CORS
makes browser multipart handling and diagnosis possible.

A cleanup failure cannot mark a connection healthy. Streamed multipart failures
retain both the upload error and any abort error in an `AggregateError`. Missing
part ETags, missing completion ETags, and embedded HTTP-200 storage errors fail.

## Verification

Run the S3 unit tests, storage persistence/HTTP tests, and
`pnpm exec vitest run --project cloudflare-contract workers/s3-oss.cf-test.ts`.
The Workers contract uses the real SDK with disposable fake credentials and an
OSS-shaped fake transport. It verifies virtual-hosted PUT/GET/DELETE, multipart
create/part/complete/abort, XML AccessDenied parsing without DOMParser, and failure
metadata. It does not contact a real bucket or replace production credentials.

For a real bucket, use the administrator's connection test for browser PUT and
strict DELETE cleanup, then upload/download a disposable object. Ordinary ZPan
uploads enter multipart above 64 MiB; local Workers tests exercise smaller
multipart data through the existing streamed-upload gateway without changing
that product threshold.

References:
- https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/
- https://www.alibabacloud.com/help/en/oss/developer-reference/use-aws-sdks-to-access-oss

## PUT succeeds but upload confirmation fails

Normal file completion verifies the object using HEAD before activating the
file in ZPan. HEAD requires `oss:GetObject` for the same object/prefix. A test
that only PUTs and DELETEs can succeed while HEAD is denied. Do not remove the
HEAD or ETag check and do not make the bucket public as a workaround.

Historically every HEAD failure was mislabeled `409 / OBJECT_NOT_FOUND`. Now
only a real 404/NotFound uses that reason. Permission errors, signing errors,
provider errors and network failures return `502 / OBJECT_VERIFICATION_FAILED`
with allowlisted HTTP status, error code and RequestId. Bodyless SDK HEAD errors
also retain `x-oss-request-id`. The draft stays unconfirmed on any failure.

A browser response showing `OBJECT_NOT_FOUND` from an older deployment does not
prove absence. Retry after the diagnostic fix and use the actual status to
check RAM/bucket policy, signing configuration, connectivity or the object key.
OSS HeadObject permission reference:
https://www.alibabacloud.com/help/en/oss/user-guide/authorization-syntax-and-elements

HEAD verification uses the SDK's presigned query authentication and Workers
`fetch`, matching the existing PUT/GET transfer path. It still requests the
same key with the same credentials, endpoint, region and addressing setting.
It requires a valid Content-Length and ETag before confirmation. A 403 continues
to fail; no GET-only fallback activates an object and no bucket policy is changed.

When HEAD is bodyless, diagnostics decode the bounded OSS `x-oss-err` header and
extract only Code, EC (`x-oss-ec`), and RequestId. No Message, signing material or
raw error header is logged. If a 403 has no usable provider diagnostics, a single
GET with `Range: bytes=0-0` obtains a structured error; a successful response is
cancelled without reading the object. HEAD denial still rejects confirmation,
even if GET succeeds. HEAD and probe/cleanup errors are retained separately.
