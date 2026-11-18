# Cloudflare single-trigger scheduler

`wrangler.toml` registers only `*/10 * * * *`. The scheduled handler uses
Cloudflare's `scheduledTime` (milliseconds UTC), not the delivery time or server timezone.

| Tasks | UTC cadence |
| --- | --- |
| Free quota baselines, traffic reports, remote download reports, enabled media library sweep | Every 10 minutes |
| Stats rollups, WebDAV lock cleanup, resource change cleanup, image domain reconciliation | Hourly at :10 |
| License refresh | 00:00, 06:00, 12:00, 18:00 |
| Instance telemetry | 00:00, 12:00 |
| Traffic quota reset | First day of each month at 00:00 |
| Expired trash purge | Daily at 04:00 |

The existing D1 `system_options` table stores one `worker_schedule:<task>` row
per task. An atomic conditional UPSERT claims the latest due slot. Completed
slots and older deliveries are skipped, and active leases prevent overlapping
invocations even across period boundaries. Old Cron expressions are ignored
during Cloudflare trigger propagation.

First deployment catches up each task once for its current period. Missed
periods coalesce into the latest due slot; this is maintenance, not historical
replay. Each task records completion separately. Rejected tasks release their
claim and are retried on a later ten-minute tick without rerunning completed
siblings. A terminated invocation leaves a 20-minute lease, longer than the
15-minute Workers scheduled wall-time limit, after which it can be retried.
Errors are logged with task name and slot; the handler waits for every task
before rejecting. Internal report backoff/idempotency and license refresh error
handling remain owned by the existing use cases.

This is at-least-once recovery, not exactly-once external side effects: a crash
after an external action but before saving completion can repeat that action.
No new Cloudflare resource, secret, or database migration is required.

## Deploy from this repository

The old workflow checked out the latest release of `saltbo/zpan`, discarding
fork fixes. `Deploy to Cloudflare Workers` now checks out the current repository
at the triggering commit by default. The optional `version` input selects a
branch, tag, or SHA **in this repository**. Leave it empty to deploy the chosen
workflow branch's commit. The Actions summary records the actual checked-out SHA
and package version, and build metadata uses that same SHA.

1. Commit the scheduler, tests, Wrangler config, workflow, and this document with
   a Conventional Commit message, then push to your repository.
2. A push to `main` invokes `Deploy`, which dispatches the Cloudflare workflow
   when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are configured.
   Alternatively run `Deploy to Cloudflare Workers` manually, select the branch
   containing the fix, and leave `version` empty.
3. Confirm the summary SHA matches your fix, the scheduler checks pass, and the
   generated `dist/zpan/wrangler.json` contains only one Cron before deployment.
4. Confirm the Worker dashboard lists `*/10 * * * *` only. Trigger changes can
   take up to 15 minutes to propagate. The account must have one available Cron
   slot; other Workers still share the free account's limit.

The workflow retains existing resource provisioning and secret handling. It
builds once, then applies production migrations and deploys the built artifact.
