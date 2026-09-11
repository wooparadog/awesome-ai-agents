-- Claude's not_available sentinel denotes missing geographic billing metadata.
-- Reprice retained evidence as a standard/global estimate, preserving raw metadata.
UPDATE usage_records SET pricing_version=''
WHERE archived=0 AND provider='anthropic'
 AND json_extract(pricing_json,'$.inference_geo')='not_available';
