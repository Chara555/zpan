import { beforeEach, describe, expect, it, vi } from 'vitest'
import { syncPendingRemoteDownloadUsageReports } from '../server/usecases/downloads/remote-download-usage'
import { sweepMediaLibraries } from '../server/usecases/media-library-scan'
import { purgeExpiredTrash } from '../server/usecases/object'
import { reconcileImageDomains } from '../server/usecases/site/image-domain-provider'
import { reportInstanceTelemetry } from '../server/usecases/site/instance-telemetry'
import { runLicensingRefresh } from '../server/usecases/site/licensing'
import { syncPendingCloudTrafficReports } from '../server/usecases/store/traffic-metering'
import { handleScheduled } from '../workers/scheduled'

vi.mock('../server/platform/cloudflare', () => ({
  createCloudflarePlatform: (env: Record<string, string | undefined>) => ({
    db: 'db',
    getEnv: (key: string) => env[key],
  }),
}))

const refreshHourlyRollups = vi.fn()
const purgeExpiredLocks = vi.fn()
const reconcileFreePlanBaselines = vi.fn()
const purgeResourceChanges = vi.fn()
const fakeDeps = {
  instance: 'instance',
  systemOptions: 'system-options',
  adminStats: { refreshHourlyRollups },
  webdavState: { purgeExpiredLocks },
  quota: { reconcileFreePlanBaselines },
  resourceChanges: { purgeBefore: purgeResourceChanges },
}
vi.mock('../server/composition', () => ({
  createDeps: vi.fn(() => fakeDeps),
}))

vi.mock('../server/usecases/store/traffic-metering', () => ({
  syncPendingCloudTrafficReports: vi.fn(),
}))

const { mockCreateQuotaRepo, mockResetExpiredTrafficQuotas } = vi.hoisted(() => {
  const resetExpiredTrafficQuotas = vi.fn()
  return {
    mockResetExpiredTrafficQuotas: resetExpiredTrafficQuotas,
    mockCreateQuotaRepo: vi.fn(() => ({ resetExpiredTrafficQuotas })),
  }
})

vi.mock('../server/adapters/repos/quota', () => ({
  createQuotaRepo: mockCreateQuotaRepo,
}))

vi.mock('../server/usecases/site/instance-telemetry', () => ({
  INSTANCE_TELEMETRY_CRON: '0 */12 * * *',
  reportInstanceTelemetry: vi.fn(),
}))

vi.mock('../server/usecases/site/licensing', () => ({
  runLicensingRefresh: vi.fn(),
}))

vi.mock('../server/usecases/site/image-domain-provider', () => ({
  reconcileImageDomains: vi.fn(),
}))

vi.mock('../server/usecases/downloads/remote-download-usage', () => ({
  syncPendingRemoteDownloadUsageReports: vi.fn(),
}))

vi.mock('../server/usecases/media-library-scan', () => ({
  sweepMediaLibraries: vi.fn(),
}))

const runTask = vi.hoisted(() => vi.fn(async (_db, _name, _slot, run) => run()))
vi.mock('../workers/scheduled-state', () => ({ runScheduledTask: runTask }))
vi.mock('../server/usecases/object', () => ({
  purgeExpiredTrash: vi.fn(),
  resolveTrashRetentionDays: () => 30,
}))

async function tick(time: string, cron = '*/10 * * * *', extra = {}) {
  await handleScheduled({ cron, scheduledTime: Date.parse(time) }, { DB: {} as D1Database, ...extra })
}

describe('handleScheduled', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs only the ten-minute jobs between slower boundaries', async () => {
    await tick('2026-11-18T03:20:00Z')
    expect(syncPendingCloudTrafficReports).toHaveBeenCalledOnce()
    expect(syncPendingRemoteDownloadUsageReports).toHaveBeenCalledOnce()
    expect(sweepMediaLibraries).toHaveBeenCalledOnce()
    expect(purgeExpiredTrash).toHaveBeenCalledWith(fakeDeps, 30)
    expect(mockResetExpiredTrafficQuotas).toHaveBeenCalledOnce()
    expect(purgeResourceChanges).toHaveBeenCalledOnce()
    // Slower jobs receive their most recent due slot, never a new slot each tick.
    expect(runTask.mock.calls.find((c) => c[1] === 'stats')?.[2]).toBe(Date.parse('2026-11-18T03:10:00Z'))
    expect(runTask.mock.calls.find((c) => c[1] === 'licensing')?.[2]).toBe(Date.parse('2026-11-18T00:00:00Z'))
  })

  it('uses the scheduled UTC time even when delivery is delayed', async () => {
    await tick('2026-12-01T00:00:00Z')
    expect(runTask.mock.calls.find((c) => c[1] === 'quota-reset')?.[2]).toBe(Date.parse('2026-12-01T00:00:00Z'))
    expect(runTask.mock.calls.find((c) => c[1] === 'stats')?.[2]).toBe(Date.parse('2026-11-30T23:10:00Z'))
    expect(runTask.mock.calls.find((c) => c[1] === 'trash')?.[2]).toBe(Date.parse('2026-11-30T04:00:00Z'))
    expect(reportInstanceTelemetry).toHaveBeenCalledWith(fakeDeps, expect.objectContaining({ cron: '0 */12 * * *' }))
  })

  it('preserves UTC boundaries for hourly, daily, six-hour and twelve-hour tasks', async () => {
    await tick('2026-11-18T12:10:00Z')
    for (const [name, time] of [
      ['stats', '2026-11-18T12:10:00Z'],
      ['trash', '2026-11-18T04:00:00Z'],
      ['licensing', '2026-11-18T12:00:00Z'],
      ['telemetry', '2026-11-18T12:00:00Z'],
      ['quota-reset', '2026-11-01T00:00:00Z'],
    ])
      expect(runTask.mock.calls.find((c) => c[1] === name)?.[2]).toBe(Date.parse(time))
  })

  it('rejects invalid scheduled times', async () => {
    await expect(tick('invalid')).rejects.toThrow('Invalid scheduledTime')
    expect(runTask).not.toHaveBeenCalled()
  })

  it('ignores legacy and unknown triggers during propagation', async () => {
    await tick('2026-11-18T00:00:00Z', '0 */6 * * *')
    await tick('2026-11-18T00:00:00Z', 'unknown')
    expect(runTask).not.toHaveBeenCalled()
    expect(runLicensingRefresh).not.toHaveBeenCalled()
  })

  it('preserves the background-job and telemetry IP settings', async () => {
    await tick('2026-11-18T12:00:00Z', undefined, {
      ZPAN_ARCHIVE_JOBS_ENABLED: 'false',
      ZPAN_TELEMETRY_ALLOW_IP: 'off',
    })
    expect(sweepMediaLibraries).not.toHaveBeenCalled()
    expect(reportInstanceTelemetry).toHaveBeenCalledWith(
      fakeDeps,
      expect.objectContaining({ config: { allowIp: false } }),
    )
  })

  it('waits for independent jobs and surfaces errors without blocking other work', async () => {
    reconcileFreePlanBaselines.mockRejectedValueOnce(new Error('baseline failure'))
    await expect(tick('2026-11-18T12:10:00Z')).rejects.toThrow()
    expect(syncPendingCloudTrafficReports).toHaveBeenCalledOnce()
    expect(refreshHourlyRollups).toHaveBeenCalledOnce()
    expect(purgeExpiredLocks).toHaveBeenCalledOnce()
    expect(reconcileImageDomains).toHaveBeenCalledOnce()
    expect(runLicensingRefresh).toHaveBeenCalledOnce()
  })
})
