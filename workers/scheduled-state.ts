// Atomic D1 leases and completion markers. Reuse system_options so deployments
// need no new resource or schema migration. One bounded row per task.
const LEASE_MS = 20 * 60 * 1000 // Longer than Workers' 15-minute scheduled wall-time limit.

export async function runScheduledTask(
  db: D1Database,
  name: string,
  slot: number,
  run: () => Promise<unknown>,
  now = Date.now(),
): Promise<void> {
  const key = `worker_schedule:${name}`
  const state = { slot, done: false, leaseUntil: now + LEASE_MS, token: crypto.randomUUID() }
  const claimed = JSON.stringify(state)
  const row = await db
    .prepare(`
    INSERT INTO system_options (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE json_extract(system_options.value, '$.leaseUntil') <= ?
      AND (json_extract(system_options.value, '$.slot') < ?
        OR (json_extract(system_options.value, '$.slot') = ?
          AND json_extract(system_options.value, '$.done') = 0))
    RETURNING key
  `)
    .bind(key, claimed, now, slot, slot)
    .first()
  if (!row) return

  try {
    await run()
    await db
      .prepare('UPDATE system_options SET value = ? WHERE key = ? AND value = ?')
      .bind(JSON.stringify({ ...state, done: true, leaseUntil: 0 }), key, claimed)
      .run()
  } catch (error) {
    // Release only our own claim. Failure (including a lost completion write)
    // remains retryable; a crashed invocation is recovered after lease expiry.
    await db
      .prepare('UPDATE system_options SET value = ? WHERE key = ? AND value = ?')
      .bind(JSON.stringify({ ...state, leaseUntil: 0 }), key, claimed)
      .run()
    throw error
  }
}
