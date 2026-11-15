-- 0002 backfilled computed_at with the migration time, which made partial-day digests final.
-- Mark every existing digest non-final so the next run falls back to the input-hash compare.
UPDATE "channel_digests" SET "computed_at" = to_timestamp(0);
