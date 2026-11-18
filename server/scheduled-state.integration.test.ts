import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runScheduledTask } from '../workers/scheduled-state'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})
function database() {
  const sqlite = new DatabaseSync(':memory:')
  databases.push(sqlite)
  sqlite.exec("CREATE TABLE system_options (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')")
  return {
    prepare(query: string) {
      return {
        bind(...args: (string | number)[]) {
          return {
            first: async () => sqlite.prepare(query).get(...args) ?? null,
            run: async () => sqlite.prepare(query).run(...args),
          }
        },
      }
    },
  } as unknown as D1Database
}

describe('durable scheduled task state', () => {
  it('deduplicates completed slots and ignores stale deliveries', async () => {
    const db = database(),
      run = vi.fn()
    await runScheduledTask(db, 'test', 100, run, 1000)
    await runScheduledTask(db, 'test', 100, run, 1001)
    await runScheduledTask(db, 'test', 99, run, 1002)
    expect(run).toHaveBeenCalledTimes(1)
    await runScheduledTask(db, 'test', 200, run, 1003)
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('retries a failure without repeating successful sibling jobs', async () => {
    const db = database(),
      good = vi.fn(),
      bad = vi.fn().mockRejectedValueOnce(new Error('offline'))
    await runScheduledTask(db, 'good', 100, good, 1000)
    await expect(runScheduledTask(db, 'bad', 100, bad, 1000)).rejects.toThrow('offline')
    await runScheduledTask(db, 'good', 100, good, 1001)
    await runScheduledTask(db, 'bad', 100, bad, 1001)
    expect(good).toHaveBeenCalledTimes(1)
    expect(bad).toHaveBeenCalledTimes(2)
  })
  it('prevents overlaps across slots and recovers abandoned leases', async () => {
    const db = database(),
      other = vi.fn()
    let finish!: () => void
    const running = runScheduledTask(
      db,
      'test',
      100,
      () =>
        new Promise<void>((r) => {
          finish = r
        }),
      1000,
    )
    await Promise.resolve()
    await Promise.resolve()
    await runScheduledTask(db, 'test', 100, other, 1001)
    await runScheduledTask(db, 'test', 200, other, 1002)
    expect(other).not.toHaveBeenCalled()
    await runScheduledTask(db, 'test', 200, other, 1000 + 20 * 60 * 1000)
    expect(other).toHaveBeenCalledOnce()
    finish()
    await running
    await runScheduledTask(db, 'test', 200, other, 2000000)
    expect(other).toHaveBeenCalledOnce()
  })
})
