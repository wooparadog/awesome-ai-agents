import type { Identity } from "./auth";
import { dayBounds } from "./snapshot";
import { catalog, resolveRates, type PricingContext } from "./pricing";
import {
  hash,
  HttpError,
  integer,
  list,
  normalize,
  object,
  optional,
  stamp,
  str,
  type Json,
} from "./protocol";

export async function ingest(env: Env, who: Identity, payload: Json) {
  const accepted: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const value of list(payload.events)) {
    const e = object(value),
      data = object(e.data || {});
    if (e.installation_id !== who.installation_id)
      throw new HttpError(403, "installation mismatch");
    const safe = {
      cwd: optional(data.cwd, 2048),
      model: optional(data.model),
      pid: data.pid == null ? null : integer(data.pid),
      source: optional(data.source),
      notification_type: optional(data.notification_type),
      reason: optional(data.reason),
    };
    const id = str(e.event_id),
      execution = str(e.execution_id),
      run = str(e.run_id),
      agent = str(e.agent, 64),
      native = str(e.native_session_id);
    const sequence = integer(e.sequence, 1),
      generation = integer(e.run_generation, 1),
      time = stamp(e.observed_at),
      source = str(e.source_event);
    if (time < Date.now() - 7 * 86400000)
      throw new HttpError(410, "event exceeds retry horizon");
    const [canonical, state] = normalize(source, safe);
    const session = await hash(
      JSON.stringify([who.workspace_id, agent, who.installation_id, native]),
    );
    const digest = await hash(
      JSON.stringify([
        id,
        execution,
        run,
        agent,
        native,
        sequence,
        generation,
        time,
        source,
        safe,
      ]),
    );
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO events(workspace_id,id,installation_id,execution_id,run_id,generation,
      session_id,native_session_id,agent,sequence,source_event,canonical_type,target_state,observed_at,received_at,payload_hash,data_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        who.workspace_id,
        id,
        who.installation_id,
        execution,
        run,
        generation,
        session,
        native,
        agent,
        sequence,
        source,
        canonical,
        state,
        time,
        Date.now(),
        digest,
        JSON.stringify(safe),
      ),
    );
    accepted.push(id);
  }
  await env.DB.batch(statements);
  return { accepted };
}

export async function presence(env: Env, who: Identity, payload: Json) {
  const now = Date.now(),
    time = stamp(payload.observed_at);
  if (time < now - 120000 || time > now + 30000)
    throw new HttpError(400, "stale presence or clock skew");
  const statements: D1PreparedStatement[] = [];
  for (const value of Array.isArray(payload.runs) && payload.runs.length === 0
    ? []
    : list(payload.runs, 128)) {
    const r = object(value);
    statements.push(
      env.DB.prepare(
        `UPDATE session_runs SET last_alive_observed_at=?,presence_received_at=?,presence_sequence=?
      WHERE workspace_id=? AND installation_id=? AND id=? AND execution_id=? AND ended_at IS NULL AND presence_sequence<?`,
      ).bind(
        time,
        now,
        integer(r.sequence, 1),
        who.workspace_id,
        who.installation_id,
        str(r.run_id),
        str(r.execution_id),
        integer(r.sequence, 1),
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE installations SET last_contact_at=?,capabilities_json=?,hostname=COALESCE(?,hostname),presence_observed_at=?
       WHERE workspace_id=? AND id=? AND (presence_observed_at IS NULL OR presence_observed_at<?)`,
    ).bind(
      now,
      JSON.stringify({
        presence: true,
        usage: payload.usage === true,
        dropped: integer(payload.dropped ?? 0),
      }),
      optional(payload.hostname, 253),
      time,
      who.workspace_id,
      who.installation_id,
      time,
    ),
    env.DB.prepare(
      `UPDATE workspaces SET revision=revision+1 WHERE id=?
      AND EXISTS(SELECT 1 FROM presence_dirty WHERE workspace_id=?)`,
    ).bind(who.workspace_id, who.workspace_id),
    env.DB.prepare(
      `INSERT INTO notification_outbox(workspace_id,pending_revision)
      SELECT id,revision FROM workspaces WHERE id=? AND EXISTS(SELECT 1 FROM presence_dirty WHERE workspace_id=?)
      ON CONFLICT(workspace_id) DO UPDATE SET pending_revision=excluded.pending_revision,next_attempt_at=0`,
    ).bind(who.workspace_id, who.workspace_id),
    env.DB.prepare("DELETE FROM presence_dirty WHERE workspace_id=?").bind(
      who.workspace_id,
    ),
  );
  await env.DB.batch(statements);
  return { ok: true };
}

export async function usage(env: Env, who: Identity, payload: Json) {
  const statements: D1PreparedStatement[] = [];
  const accepted: string[] = [];
  const ownedRuns = new Set<string>();
  const now = Date.now();
  const config = await env.DB.prepare(
    "SELECT reporting_timezone,usage_reset_at FROM workspaces WHERE id=?",
  )
    .bind(who.workspace_id)
    .first<{ reporting_timezone: string; usage_reset_at: number }>();
  if (!config) throw new HttpError(404, "workspace not found");
  const days: [number, number][] = [];
  const ignored: string[] = [];
  for (const value of list(payload.records, 64)) {
    const r = object(value),
      counts = object(r.counters),
      run = str(r.run_id),
      agent = str(r.agent, 64),
      provider = str(r.provider, 64);
    const record = str(r.native_record_id, 512),
      stream = str(r.stream_id, 512),
      epoch = str(r.counter_epoch || "0");
    const kind = str(r.measurement_kind),
      time = stamp(r.occurred_at),
      model = optional(r.model);
    if (kind !== "delta" && kind !== "cumulative")
      throw new HttpError(400, "invalid measurement_kind");
    if (time < now - 7 * 86400000 || time < config.usage_reset_at) {
      // A resumed transcript can replay old IDs after detailed deduplication
      // records have expired. Acknowledge them without adding them a second time.
      accepted.push(record);
      ignored.push(record);
      continue;
    }
    let day = days.find(([from, to]) => time >= from && time < to);
    if (!day) {
      day = dayBounds(time, config.reporting_timezone);
      days.push(day);
    }
    if (!ownedRuns.has(run)) {
      const owner = await env.DB.prepare(
        "SELECT id FROM session_runs WHERE workspace_id=? AND id=? AND installation_id=?",
      )
        .bind(who.workspace_id, run, who.installation_id)
        .first();
      if (!owner) throw new HttpError(409, "run not yet ingested");
      ownedRuns.add(run);
    }
    const input = integer(counts.input ?? 0),
      output = integer(counts.output ?? 0),
      cached = integer(counts.cache_read ?? 0),
      w5 = integer(counts.cache_write_5m ?? 0),
      w1 = integer(counts.cache_write_1h ?? 0);
    if (kind === "cumulative" && cached > input)
      throw new HttpError(400, "cached input exceeds input");
    integer(input + cached + w5 + w1);
    const rawPricing = object(r.pricing || {});
    const pricing: PricingContext = {};
    for (const key of [
      "service_tier",
      "speed",
      "inference_geo",
      "billing_provider",
    ] as const) {
      if (rawPricing[key] != null) pricing[key] = str(rawPricing[key], 64);
    }
    const rates = resolveRates(
      provider,
      model,
      kind,
      {
        input,
        output,
        cache_read: cached,
        cache_write_5m: w5,
        cache_write_1h: w1,
      },
      pricing,
      time,
    );
    const id = await hash(JSON.stringify([provider, record]));
    const digest = await hash(
      JSON.stringify([
        agent,
        provider,
        record,
        stream,
        epoch,
        kind,
        time,
        model,
        input,
        output,
        cached,
        w5,
        w1,
      ]),
    );
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO usage_records(workspace_id,id,installation_id,agent,provider,native_record_id,stream_id,
      counter_epoch,model,occurred_at,received_at,measurement_kind,input,output,cache_read,cache_write_5m,cache_write_1h,payload_hash,day_start,day_end,pricing_json,resolved_rates,pricing_version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(
        who.workspace_id,
        id,
        who.installation_id,
        agent,
        provider,
        record,
        stream,
        epoch,
        model,
        time,
        Date.now(),
        kind,
        input,
        output,
        cached,
        w5,
        w1,
        digest,
        day[0],
        day[1],
        JSON.stringify(pricing),
        JSON.stringify(rates),
        catalog.version,
      ),
    );
    if (Object.keys(pricing).length) {
      // A reporter upgrade can enrich retained evidence without changing its ID
      // or counters. Queue merged metadata for the same bounded repricer.
      statements.push(
        env.DB.prepare(
          `UPDATE usage_records
        SET pricing_json=json_patch(pricing_json,?),pricing_version='',
          resolved_rates=json_set(COALESCE(resolved_rates,'{}'),'$._estimated',1)
        WHERE workspace_id=? AND id=? AND archived=0
        AND EXISTS(SELECT 1 FROM json_each(?) j WHERE json_extract(pricing_json,'$.'||j.key) IS NULL)`,
        ).bind(
          JSON.stringify(pricing),
          who.workspace_id,
          id,
          JSON.stringify(pricing),
        ),
      );
    }
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO usage_observations(workspace_id,usage_id,run_id) VALUES(?,?,?)",
      ).bind(who.workspace_id, id, run),
    );
    accepted.push(record);
  }
  if (statements.length) {
    statements.push(
      env.DB.prepare(
        "UPDATE workspaces SET revision=revision+1 WHERE id=? AND EXISTS(SELECT 1 FROM statistics_dirty WHERE workspace_id=?)",
      ).bind(who.workspace_id, who.workspace_id),
      env.DB.prepare(
        `INSERT INTO notification_outbox(workspace_id,pending_revision) SELECT id,revision FROM workspaces
        WHERE id=? AND EXISTS(SELECT 1 FROM statistics_dirty WHERE workspace_id=?)
        ON CONFLICT(workspace_id) DO UPDATE SET pending_revision=excluded.pending_revision,next_attempt_at=0`,
      ).bind(who.workspace_id, who.workspace_id),
      env.DB.prepare("DELETE FROM statistics_dirty WHERE workspace_id=?").bind(
        who.workspace_id,
      ),
    );
    const result = await env.DB.batch(statements);
    console.info(
      JSON.stringify({
        event: "usage_write_cost",
        rows_read: result.reduce((n, r) => n + r.meta.rows_read, 0),
        rows_written: result.reduce((n, r) => n + r.meta.rows_written, 0),
        records: accepted.length - ignored.length,
      }),
    );
  }
  return { accepted, ignored };
}
