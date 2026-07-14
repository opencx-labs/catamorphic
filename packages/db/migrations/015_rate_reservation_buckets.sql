CREATE TABLE rate_reservation_buckets (
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  global_key               varchar(500) NOT NULL,
  partition_key            varchar(500) NOT NULL DEFAULT '',
  capacity                 numeric NOT NULL,
  tokens                   numeric NOT NULL,
  refill_rate_per_second   numeric NOT NULL,
  refilled_at              timestamptz NOT NULL DEFAULT clock_timestamp(),
  blocked_until            timestamptz,
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, global_key, partition_key),
  CONSTRAINT chk_rate_reservation_capacity CHECK (capacity > 0),
  CONSTRAINT chk_rate_reservation_tokens CHECK (tokens >= 0 AND tokens <= capacity),
  CONSTRAINT chk_rate_reservation_refill_rate CHECK (refill_rate_per_second > 0)
);

CREATE INDEX idx_rate_reservation_buckets_blocked
  ON rate_reservation_buckets(blocked_until)
  WHERE blocked_until IS NOT NULL;
