-- CORE-PAYMENTS-PILOTS-REREVIEW-02 F1/F4.
--
-- F4: 0009 backfilled first_submitted_at from updated_at, which the old
-- executor moved on every attempt — that is not evidence of the FIRST send.
-- This migration retires every value it cannot prove and records provenance
-- for the ones the new executor writes.
ALTER TABLE payment_refund
  ADD COLUMN first_submitted_proven boolean NOT NULL DEFAULT false;

-- Everything written before this migration is unproven (including the 0009
-- backfill on an upgraded database). A NULL time means "unknown": the executor
-- sends no money and routes the intent to reconciliation.
UPDATE payment_refund
SET first_submitted_at = NULL
WHERE first_submitted_proven = false;

-- F1: how many times the executor has asked the provider to confirm a refund
-- it already has an answer for. Bounded, so a refund cannot sit SUBMITTED
-- forever without a visible escalation.
ALTER TABLE payment_refund
  ADD COLUMN confirmations integer NOT NULL DEFAULT 0;
