// Before-optimization query, retained only for read-cost regression measurements.
// Resolve prices per evidence timestamp before grouping, including effective dates.
export const usageQuery = `SELECT u.*,(SELECT json_group_object(metric,nano_usd_per_token) FROM price_rates p
 WHERE p.provider=u.provider AND (p.model=u.model OR (substr(u.model,1,length(p.model)+1)=p.model||'-'
 AND length(u.model)=length(p.model)+9 AND substr(u.model,length(p.model)+2) NOT GLOB '*[^0-9]*')
 OR (substr(u.model,1,length(p.model)+1)=p.model||'@' AND length(u.model)>length(p.model)+1
 AND substr(u.model,length(p.model)+2) NOT GLOB '*[^0-9]*')) AND p.effective_from<=u.occurred_at AND (p.effective_to IS NULL OR p.effective_to>u.occurred_at)) AS rates
 FROM usage_deltas u JOIN usage_records original ON original.workspace_id=u.workspace_id AND original.id=u.id
 WHERE u.workspace_id=? AND u.occurred_at>=? AND u.occurred_at<? AND original.archived=0 LIMIT 10001`;
