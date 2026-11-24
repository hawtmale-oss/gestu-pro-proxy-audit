-- PII-free server-side funnel counters (daily UTC aggregates).
-- Zero user IDs, zero device hashes, zero IPs, zero prompt or response content.
--
-- Allowed metric values:
--   - trial_started : first Free trial provisioned for a device
--   - trial_cap_hit : Free trial reached its per-user $0.50 cap or 7-day window
--   - pro_activated : new Pro subscription or licence activated
--   - day7_active   : user active on Day 7+ since first seen

CREATE TABLE IF NOT EXISTS funnel_daily_counters (
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, metric)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_funnel_daily_counters_day
  ON funnel_daily_counters (day);
