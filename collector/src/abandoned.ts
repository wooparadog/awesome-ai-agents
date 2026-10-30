import { revisionBump } from "./subscriptions";

// Reporters end the runs they can observe. A run can still be left open when its
// machine was wiped or retired, or an older reporter never identified its process.
// Past the seven-day retry horizon no delayed event can change such a run, so
// end it at its last evidence instead of listing it as stale or unverified forever.
export const ABANDONED_AFTER_MS = 7 * 86400000;

export async function endAbandoned(env: Env, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `UPDATE session_runs SET state='ended',end_reason='abandoned',
      ended_at=MAX(last_activity_at,COALESCE(presence_received_at,0))
    WHERE rowid IN (SELECT rowid FROM session_runs WHERE ended_at IS NULL
      AND MAX(last_activity_at,COALESCE(presence_received_at,0))<? LIMIT 500)
    RETURNING workspace_id`,
  )
    .bind(now - ABANDONED_AFTER_MS)
    .all<{ workspace_id: string }>();
  const workspaces = new Set(results.map((r) => r.workspace_id));
  if (workspaces.size)
    await env.DB.batch([...workspaces].flatMap((w) => revisionBump(env, w)));
  return results.length;
}
