import { dayBounds, usageQuery, summarize } from "./snapshot";
export async function retain(env: Env): Promise<void> {
  const now = Date.now(),
    cutoff = now - 90 * 86400000;
  const workspaces = await env.DB.prepare(
    `SELECT w.id,w.reporting_timezone,MIN(u.occurred_at) AS oldest FROM workspaces w JOIN usage_records u
    ON u.workspace_id=w.id WHERE u.archived=0 AND u.occurred_at<? GROUP BY w.id LIMIT 4`,
  )
    .bind(cutoff)
    .all<{ id: string; reporting_timezone: string; oldest: number }>();
  for (const w of workspaces.results) {
    const [from, to] = dayBounds(w.oldest, w.reporting_timezone);
    if (to > cutoff) continue;
    const rows = await env.DB.prepare(usageQuery).bind(w.id, from, to).all();
    // Preserve evidence if a single day's archive exceeds the bounded work budget.
    if (rows.results.length > 10000) {
      console.warn(
        JSON.stringify({ event: "archive_day_too_large", workspace: w.id }),
      );
      continue;
    }
    const sums = summarize(rows.results);
    const writes = Object.entries(sums).map(([agent, sum]) =>
      env.DB.prepare(
        `INSERT INTO usage_daily(workspace_id,day_start,day_end,timezone,agent,tokens,nano_usd,priced,complete)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,day_start,timezone,agent) DO NOTHING`,
      ).bind(
        w.id,
        from,
        to,
        w.reporting_timezone,
        agent,
        sum.tokens,
        sum.nano.toString(),
        Number(sum.priced),
        Number(sum.complete),
      ),
    );
    writes.push(
      env.DB.prepare(
        "UPDATE usage_records SET archived=1 WHERE workspace_id=? AND occurred_at>=? AND occurred_at<?",
      ).bind(w.id, from, to),
    );
    // Archival changes API granularity; publish the changed snapshot contract.
    writes.push(
      env.DB.prepare(
        "UPDATE workspaces SET revision=revision+1 WHERE id=?",
      ).bind(w.id),
    );
    writes.push(
      env.DB.prepare(
        `INSERT INTO notification_outbox(workspace_id,pending_revision) SELECT id,revision FROM workspaces WHERE id=?
      ON CONFLICT(workspace_id) DO UPDATE SET pending_revision=excluded.pending_revision,next_attempt_at=0`,
      ).bind(w.id),
    );
    await env.DB.batch(writes);
  }
  // Retain the most recent cumulative sample before the cutoff as a baseline.
  // Observations reference usage evidence; delete links before the parent rows.
  const doomed = `SELECT u.rowid FROM usage_records u WHERE archived=1 AND occurred_at<?
    AND (measurement_kind='delta' OR EXISTS(SELECT 1 FROM usage_records n WHERE n.workspace_id=u.workspace_id AND n.stream_id=u.stream_id
      AND n.counter_epoch=u.counter_epoch AND n.occurred_at>u.occurred_at AND n.occurred_at<?)) LIMIT 500`;
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM usage_observations WHERE (workspace_id,usage_id) IN (SELECT workspace_id,id FROM usage_records WHERE rowid IN (${doomed}))`,
    ).bind(cutoff, cutoff),
    env.DB.prepare(`DELETE FROM usage_records WHERE rowid IN (${doomed})`).bind(
      cutoff,
      cutoff,
    ),
    env.DB.prepare(
      "DELETE FROM events WHERE rowid IN (SELECT rowid FROM events WHERE received_at<? LIMIT 500)",
    ).bind(now - 30 * 86400000),
    env.DB.prepare(
      "DELETE FROM usage_daily WHERE rowid IN (SELECT rowid FROM usage_daily WHERE day_end<? LIMIT 500)",
    ).bind(now - 365 * 86400000),
    env.DB.prepare(
      `UPDATE session_runs SET cwd=NULL,model=NULL,pid=NULL WHERE rowid IN
      (SELECT rowid FROM session_runs WHERE ended_at<? AND (cwd IS NOT NULL OR model IS NOT NULL OR pid IS NOT NULL) LIMIT 500)`,
    ).bind(cutoff),
  ]);
  // Keep compact run/execution identities as tombstones. They prevent late hooks
  // from resurrecting processes, and retain the joins for surviving usage evidence.
}
