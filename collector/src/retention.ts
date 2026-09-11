// Detailed evidence is only needed for a bounded retry/correction window. Daily
// totals survive pruning; cleanup never reconstructs history or subtracts totals.
export async function retain(env: Env, now = Date.now()): Promise<void> {
  const state = await env.DB.prepare(
    "SELECT ready FROM statistics_state WHERE id=1",
  ).first<{ ready: number }>();
  if (!state?.ready) return;
  // Finish repricing retained evidence before it can be frozen or deleted.
  if (
    await env.DB.prepare(
      "SELECT 1 FROM usage_records WHERE archived=0 AND pricing_version='' LIMIT 1",
    ).first()
  )
    return;
  const claim = await env.DB.prepare(
    `INSERT INTO maintenance_runs(id,last_run) VALUES('compact',?)
    ON CONFLICT(id) DO UPDATE SET last_run=excluded.last_run WHERE last_run<=?`,
  )
    .bind(now, now - 3600000)
    .run();
  if (!claim.meta.changes) return;
  const cutoff = now - 7 * 86400000,
    summaryCutoff = now - 30 * 86400000;
  const expired = `SELECT workspace_id,id FROM usage_records WHERE archived=0 AND occurred_at<?
    AND day_start IS NOT NULL ORDER BY occurred_at LIMIT 500`;
  const doomed = `SELECT u.workspace_id,u.id FROM usage_records u WHERE u.archived=1 AND u.occurred_at<?
    AND (u.measurement_kind='delta' OR u.occurred_at<? OR EXISTS(
      SELECT 1 FROM usage_records n WHERE n.workspace_id=u.workspace_id AND n.provider=u.provider
      AND n.stream_id=u.stream_id AND n.counter_epoch=u.counter_epoch
      AND (n.occurred_at,n.id)>(u.occurred_at,u.id) AND n.occurred_at<?))
    ORDER BY u.occurred_at LIMIT 500`;
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM browser_links WHERE id IN (SELECT id FROM browser_links WHERE expires_at<=? LIMIT 500)",
    ).bind(now),
    env.DB.prepare(
      "DELETE FROM browser_tickets WHERE id IN (SELECT id FROM browser_tickets WHERE expires_at<=? LIMIT 500)",
    ).bind(now),
    env.DB.prepare(
      "DELETE FROM rate_limits WHERE token_id IN (SELECT id FROM api_tokens WHERE parent_token_id IS NOT NULL AND expires_at<=? ORDER BY expires_at LIMIT 500)",
    ).bind(now),
    env.DB.prepare(
      "DELETE FROM api_tokens WHERE id IN (SELECT id FROM api_tokens WHERE parent_token_id IS NOT NULL AND expires_at<=? ORDER BY expires_at LIMIT 500)",
    ).bind(now),
    env.DB.prepare(
      `UPDATE usage_contributions SET frozen=1 WHERE (workspace_id,id) IN (${expired})`,
    ).bind(cutoff),
    env.DB.prepare(
      `DELETE FROM usage_contributions WHERE frozen=1 AND (workspace_id,id) IN (${expired})`,
    ).bind(cutoff),
    env.DB.prepare(
      `DELETE FROM usage_observations WHERE (workspace_id,usage_id) IN (${expired})`,
    ).bind(cutoff),
    env.DB.prepare(
      `UPDATE usage_records SET archived=1 WHERE (workspace_id,id) IN (${expired})`,
    ).bind(cutoff),
    // Keep one old cumulative baseline per stream while it can still affect
    // retained statistics. Everything else can be discarded after seven days.
    env.DB.prepare(
      `DELETE FROM usage_observations WHERE (workspace_id,usage_id) IN (${doomed})`,
    ).bind(cutoff, summaryCutoff, cutoff),
    env.DB.prepare(
      `DELETE FROM usage_records WHERE (workspace_id,id) IN (${doomed})`,
    ).bind(cutoff, summaryCutoff, cutoff),
    env.DB.prepare(
      "DELETE FROM usage_rollups WHERE rowid IN (SELECT rowid FROM usage_rollups WHERE day_start<? AND day_end<=? LIMIT 500)",
    ).bind(summaryCutoff, summaryCutoff),
    env.DB.prepare(
      "DELETE FROM usage_daily WHERE rowid IN (SELECT rowid FROM usage_daily WHERE day_end<=? LIMIT 500)",
    ).bind(summaryCutoff),
    env.DB.prepare(
      "DELETE FROM events WHERE rowid IN (SELECT rowid FROM events WHERE received_at<? LIMIT 500)",
    ).bind(cutoff),
    env.DB.prepare(
      `UPDATE session_runs SET cwd=NULL,model=NULL,pid=NULL,usage_model=NULL WHERE rowid IN
      (SELECT rowid FROM session_runs WHERE ended_at<? AND (cwd IS NOT NULL OR model IS NOT NULL OR pid IS NOT NULL OR usage_model IS NOT NULL) LIMIT 500)`,
    ).bind(cutoff),
    env.DB.prepare(
      `DELETE FROM session_runs WHERE rowid IN (SELECT r.rowid FROM session_runs r
      WHERE r.ended_at<? AND NOT EXISTS(SELECT 1 FROM usage_observations o WHERE o.workspace_id=r.workspace_id AND o.run_id=r.id) LIMIT 500)`,
    ).bind(summaryCutoff),
    env.DB.prepare(
      `DELETE FROM executions WHERE rowid IN (SELECT e.rowid FROM executions e WHERE e.created_at<?
      AND NOT EXISTS(SELECT 1 FROM session_runs r WHERE r.workspace_id=e.workspace_id AND r.execution_id=e.id) LIMIT 500)`,
    ).bind(summaryCutoff),
    env.DB.prepare(
      `DELETE FROM sessions WHERE rowid IN (SELECT s.rowid FROM sessions s WHERE s.first_observed_at<?
      AND NOT EXISTS(SELECT 1 FROM session_runs r WHERE r.workspace_id=s.workspace_id AND r.session_id=s.id) LIMIT 500)`,
    ).bind(summaryCutoff),
  ]);
}
