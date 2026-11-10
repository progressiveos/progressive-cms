-- CORE-PAYMENTS-YOOKASSA-MONEY-REVIEW-01 B1-B3: the refund lifecycle needs a
-- durable record of the first external submission (the idempotency key
-- expires after provider_first_submitted_at + window, not after the latest
-- diagnostic update), and an unknown outcome must keep reserving the amount
-- until it is resolved (NEEDS_REVIEW included in the one-active-intent index).
ALTER TABLE payment_refund
  ADD COLUMN first_submitted_at timestamptz;

-- Backfill from what the previous code actually knew: a row that left
-- REQUESTED was submitted at its last update. Unknown stays NULL.
UPDATE payment_refund
SET first_submitted_at = updated_at
WHERE status <> 'REQUESTED';

CREATE INDEX payment_refund_pending_poll
  ON payment_refund (first_submitted_at)
  WHERE status = 'SUBMITTED';

DROP INDEX payment_refund_one_active;

CREATE UNIQUE INDEX payment_refund_one_active
  ON payment_refund (payment_id)
  WHERE status = ANY (ARRAY['REQUESTED'::text, 'SUBMITTED'::text, 'NEEDS_REVIEW'::text]);
