import { env } from 'cloudflare:workers'
import { describe, expect, it, vi } from 'vitest'
import { runScheduledTask } from './scheduled-state'

describe('scheduler D1 claims', () => {
  it('atomically deduplicates concurrent deliveries and retries failed slots', async () => {
    const name = 'd1-contract'
    const run = vi.fn(async () => {})
    await env.DB.prepare('DELETE FROM system_options WHERE key = ?').bind(`worker_schedule:${name}`).run()
    try {
      await Promise.all([runScheduledTask(env.DB, name, 100, run), runScheduledTask(env.DB, name, 100, run)])
      expect(run).toHaveBeenCalledOnce()
      const fail = vi.fn(async () => {
        throw new Error('offline')
      })
      await expect(runScheduledTask(env.DB, name, 200, fail)).rejects.toThrow('offline')
      await runScheduledTask(env.DB, name, 200, run)
      await runScheduledTask(env.DB, name, 200, run)
      expect(run).toHaveBeenCalledTimes(2)
    } finally {
      await env.DB.prepare('DELETE FROM system_options WHERE key = ?').bind(`worker_schedule:${name}`).run()
    }
  })
})
