// CF Workers scheduled() handler.

import { createQuotaRepo } from '../server/adapters/repos/quota'
import { createDeps } from '../server/composition'
import { createCloudflarePlatform } from '../server/platform/cloudflare'
import { backgroundJobsEnabled } from '../server/platform/interface'
import { syncPendingRemoteDownloadUsageReports } from '../server/usecases/downloads/remote-download-usage'
import { sweepMediaLibraries } from '../server/usecases/media-library-scan'
import { purgeExpiredTrash, resolveTrashRetentionDays } from '../server/usecases/object'
import { purgeExpiredResourceChanges } from '../server/usecases/resource-changes'
import { reconcileImageDomains } from '../server/usecases/site/image-domain-provider'
import { INSTANCE_TELEMETRY_CRON, reportInstanceTelemetry } from '../server/usecases/site/instance-telemetry'
import { runLicensingRefresh } from '../server/usecases/site/licensing'
import { syncPendingCloudTrafficReports } from '../server/usecases/store/traffic-metering'
import { ZPAN_CLOUD_URL_DEFAULT } from '../shared/constants'
import { runScheduledTask } from './scheduled-state'

// Subset of the worker Env used by the scheduled handler.
// The full Env is defined in bootstrap.ts; this avoids circular imports.
export interface ScheduledEnv {
  DB: D1Database
  ZPAN_CLOUD_URL?: string
  ZPAN_TELEMETRY_ALLOW_IP?: string
  ZPAN_TRASH_RETENTION_DAYS?: string
  ZPAN_ARCHIVE_JOBS_ENABLED?: string
  [key: string]: unknown
}

const SCHEDULER_CRON = '*/10 * * * *'
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
type ScheduledTrigger = Pick<ScheduledEvent, 'cron' | 'scheduledTime'>

// Latest UTC occurrence. Missed ticks coalesce into one catch-up per task;
// retries keep the same slot instead of turning slow jobs into ten-minute jobs.
function periodicSlot(time: number, period: number, offset = 0): number {
  return Math.floor((time - offset) / period) * period + offset
}

function envAllowsIp(value: string | undefined): boolean {
  return !['0', 'false', 'no', 'off'].includes(value?.trim().toLowerCase() ?? '')
}

export async function handleScheduled(event: ScheduledTrigger, env: ScheduledEnv): Promise<void> {
  // Old schedules can still arrive while Cloudflare propagates trigger changes.
  if (event.cron !== SCHEDULER_CRON) return
  if (!Number.isFinite(event.scheduledTime)) throw new Error('Invalid scheduledTime')
  const time = event.scheduledTime
  const now = new Date(time)
  const platform = createCloudflarePlatform(env)
  const deps = createDeps(platform)
  const cloudBaseUrl = env.ZPAN_CLOUD_URL ?? ZPAN_CLOUD_URL_DEFAULT
  const traffic = periodicSlot(time, 10 * MINUTE)
  const hourly = periodicSlot(time, HOUR, 10 * MINUTE)
  const monthly = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  const tasks: { name: string; slot: number; run: () => Promise<unknown> }[] = [
    { name: 'baselines', slot: traffic, run: () => deps.quota.reconcileFreePlanBaselines() },
    { name: 'traffic', slot: traffic, run: () => syncPendingCloudTrafficReports(deps, { cloudBaseUrl }) },
    {
      name: 'remote-download',
      slot: traffic,
      run: () => syncPendingRemoteDownloadUsageReports(deps, { cloudBaseUrl }),
    },
    { name: 'stats', slot: hourly, run: () => deps.adminStats.refreshHourlyRollups(now) },
    { name: 'webdav-locks', slot: hourly, run: () => deps.webdavState.purgeExpiredLocks() },
    { name: 'resource-changes', slot: hourly, run: () => purgeExpiredResourceChanges(deps, now) },
    { name: 'image-domains', slot: hourly, run: () => reconcileImageDomains(deps) },
    { name: 'quota-reset', slot: monthly, run: () => createQuotaRepo(platform.db).resetExpiredTrafficQuotas() },
    {
      name: 'trash',
      slot: periodicSlot(time, DAY, 4 * HOUR),
      run: () => purgeExpiredTrash(deps, resolveTrashRetentionDays(env.ZPAN_TRASH_RETENTION_DAYS)),
    },
    { name: 'licensing', slot: periodicSlot(time, 6 * HOUR), run: () => runLicensingRefresh(deps, cloudBaseUrl) },
    {
      name: 'telemetry',
      slot: periodicSlot(time, 12 * HOUR),
      run: () =>
        reportInstanceTelemetry(deps, {
          config: { allowIp: envAllowsIp(env.ZPAN_TELEMETRY_ALLOW_IP) },
          cron: INSTANCE_TELEMETRY_CRON,
          trigger: 'scheduled',
          runtime: { runtime: 'workerd', platform: 'cloudflare-workers' },
        }),
    },
  ]
  if (backgroundJobsEnabled(platform)) {
    tasks.push({ name: 'media-library', slot: traffic, run: () => sweepMediaLibraries(deps, { cloudBaseUrl }) })
  }
  const results = await Promise.allSettled(
    tasks.map(async ({ name, slot, run }) => {
      try {
        await runScheduledTask(env.DB, name, slot, run)
      } catch (error) {
        console.error('scheduled.task.failed', { name, slot, error })
        throw error
      }
    }),
  )
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Scheduled tasks failed',
    )
}
