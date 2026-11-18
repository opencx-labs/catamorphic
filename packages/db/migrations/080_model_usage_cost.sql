-- Usage and provider cost (ADR 0329): what the provider said it charged for
-- one model call, in US dollars, read from the answer's `usage.cost`
-- (OpenRouter's, streamed or not). Null when the answer reported none: Work
-- never estimates a price.
ALTER TABLE model_usage ADD COLUMN cost_usd numeric;

-- Whether the answer's final usage was read. A call it was not read for (a
-- Chat Completions stream without `stream_options.include_usage`, a stream
-- that ended early, an answer too large to scan) records zero tokens that are
-- not a measurement. Earlier rows count as read when they recorded tokens.
ALTER TABLE model_usage ADD COLUMN metered boolean DEFAULT false NOT NULL;
UPDATE model_usage SET metered = true
    WHERE input_tokens > 0 OR cached_input_tokens > 0
       OR cache_creation_tokens > 0 OR output_tokens > 0;
