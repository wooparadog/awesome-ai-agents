import { catalog, resolveRates, type Counters } from "./pricing";

export type PriceRecord = Counters & {
  workspace_id: string;
  id: string;
  provider: string;
  model: string | null;
  measurement_kind: string;
  occurred_at: number;
  pricing_json: string;
};
export const pendingPrices = `SELECT workspace_id,id,provider,model,measurement_kind,occurred_at,
  input,output,cache_read,cache_write_5m,cache_write_1h,pricing_json FROM usage_records
  WHERE archived=0 AND pricing_version='' ORDER BY workspace_id,id LIMIT 200`;
export function recordRates(row: PriceRecord) {
  return JSON.stringify(
    resolveRates(
      row.provider,
      row.model,
      row.measurement_kind,
      row,
      JSON.parse(row.pricing_json),
      row.occurred_at,
    ),
  );
}

// Hourly maintenance catches migrations and metadata recovered by upgraded
// reporters. Each guarded UPDATE and its rollup triggers are atomic and retryable.
export async function reprice(env: Env): Promise<number> {
  const rows = (await env.DB.prepare(pendingPrices).all<PriceRecord>()).results;
  if (!rows.length) return 0;
  const statements = rows.map((row) =>
    env.DB.prepare(
      `UPDATE usage_records
    SET resolved_rates=?,pricing_version=? WHERE workspace_id=? AND id=?
    AND pricing_json=? AND archived=0 AND pricing_version=''`,
    ).bind(
      recordRates(row),
      catalog.version,
      row.workspace_id,
      row.id,
      row.pricing_json,
    ),
  );
  for (const workspace of new Set(rows.map((row) => row.workspace_id))) {
    statements.push(
      env.DB.prepare(
        "UPDATE workspaces SET revision=revision+1 WHERE id=?",
      ).bind(workspace),
    );
    statements.push(
      env.DB.prepare(
        `INSERT INTO notification_outbox(workspace_id,pending_revision)
      SELECT id,revision FROM workspaces WHERE id=?
      ON CONFLICT(workspace_id) DO UPDATE SET pending_revision=excluded.pending_revision,next_attempt_at=0`,
      ).bind(workspace),
    );
  }
  await env.DB.batch(statements);
  return rows.length;
}
