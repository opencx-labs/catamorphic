-- Usage and provider cost (ADR 0329): what the provider said it charged for
-- one model call, in US dollars, read from the answer's `usage.cost`
-- (OpenRouter's, streamed or not). Null when the answer reported none: Work
-- never estimates a price.
ALTER TABLE model_usage ADD COLUMN cost_usd numeric;
