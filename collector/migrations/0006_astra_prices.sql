-- Standard short-context API estimates, verified 2026-09-09.
-- https://developers.openai.com/api/docs/models/gpt-6-astra
-- Codex subscription billing, fast mode, and long-context premiums are not inferred.
INSERT INTO price_rates(provider,model,metric,nano_usd_per_token,effective_from,source) VALUES
('openai','gpt-6-astra','input',10000,1788912000000,'https://developers.openai.com/api/docs/models/gpt-6-astra; standard API estimate'),
('openai','gpt-6-astra','output',50000,1788912000000,'https://developers.openai.com/api/docs/models/gpt-6-astra; standard API estimate'),
('openai','gpt-6-astra','cache_read',1000,1788912000000,'https://developers.openai.com/api/docs/models/gpt-6-astra; standard API estimate'),
('openai','gpt-6-astra','cache_write_5m',12500,1788912000000,'https://developers.openai.com/api/docs/models/gpt-6-astra; standard API estimate');
