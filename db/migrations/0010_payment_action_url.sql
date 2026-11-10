-- CORE-PAYMENTS-TBANK-PILOT-REVIEW-01 T3: a provider-hosted payment form
-- (T-Bank PaymentURL) must survive the call that created it, so a replay and a
-- restart hand the storefront the same payment action instead of losing it.
ALTER TABLE payment
  ADD COLUMN payment_url text;
