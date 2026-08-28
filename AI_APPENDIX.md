# Form 5 — AI Interaction Summary

## Which AI tools (and models) did I use?

Claude Sonnet 5, via Claude Code (Anthropic's CLI agent), through the entire process.

## The 2 most critical and comprehensive prompts

**1. Scenario A — ingestion durability and connection-safety audit:**
> "Guarantee that every insert performed during ingestion is durable and that
> concurrent batch processing cannot produce duplicate or miscounted data.
> Additionally, confirm that a running ingestion job cannot degrade or block
> normal API users performing routine reads/writes at the same time — if
> connection exhaustion or contention under concurrent Lambda invocations is
> possible, correct the connection strategy."

This drove a full audit of `processBatch`'s failure paths (three real bugs
surfaced, below). The connection-safety half didn't uncover a bug — this
account's own Lambda concurrency cap (10) already bounds simultaneous direct
connections — but confirming that with the actual account limits, rather than
assuming it, was the point of asking.

**2. Scenario B — cache stampede under concurrent identical requests:**
> "If the cache is empty and many identical requests arrive at the same
> instant — as they would the moment a flash sale is created and every cached
> page for that category is invalidated — ensure the system doesn't let all of
> them fall through to the database at once. Add whatever coordination is
> needed so a cold cache produces at most one real query, not one per
> concurrent request."

This is what led to adding lock-based stampede protection to `cacheGetOrSet` —
without it, invalidating a category's cache during a real flash sale would let
every one of the next thousands of requests hit Postgres simultaneously,
reproducing the exact bottleneck the cache exists to remove.

## Error Correction

Three mistakes worth recording — Scenario A, Scenario B, and §1 each produced a
distinct kind of failure, all caught by direct questioning rather than by testing alone.

### Biggest — Scenario A: no theory of partial failure in batch processing

The first version treated a batch as all-or-nothing (one multi-row `INSERT ... ON
CONFLICT`), with a per-attempt catch that marked it `FAILED` and bumped
`failedRows` by 1. Three compounding problems: **(1)** one bad row (e.g. a
duplicate SKU within the batch) failed all ~2,000 rows in it, not just the bad
one; **(2)** a batch that permanently failed after 3 SQS attempts landed in the
dead-letter queue with nothing consuming it or alerting anyone — `processedRows`
would just stop advancing, silently; **(3)** counting failures per-attempt
double-counted every transient error that later succeeded on retry.

**Fix:** bulk insert first, fall back to per-row savepoints on failure (isolates
only the genuinely bad row); a dedicated `handleFailedBatch` Lambda consuming the
DLQ as the *only* place `failedRows` is counted (guarded by `FOR UPDATE`) and
that fires an SNS alert. Verified live: a re-uploaded 500k-row file produced 0
failures and no duplicates; a batch that hit a real Lambda timeout mid-test was
retried and completed correctly with no manual fix.

### Scenario B: a write-side race the transaction didn't actually prevent

`createPromotion` wrapped its overlap check + insert in one transaction, which
looks like it should prevent two overlapping promotions on the same
product — but Postgres's default READ COMMITTED isolation doesn't protect a
check-then-act across two *concurrent* transactions. Verified the bug live: two
truly concurrent requests creating overlapping promotions for the same product
both succeeded in 5/5 trials, leaving two active promotions where the rule allows
one.

**Fix:** `pg_advisory_xact_lock(hashtext(targetId))` acquired at the start of the
transaction — locks the target id itself even when there's no existing row to
`SELECT ... FOR UPDATE` (the first promotion for a product has nothing to
select). Re-ran the same 5 concurrent trials: exactly one winner every time, the
other correctly `409`.

### §1: promotion precedence was specificity, not correctness

`resolveActivePromotionForProduct` originally returned a product-level promotion
immediately if one existed, never checking the category-level one — a clean rule
that's silently wrong if the category promotion is edited later and becomes the
better deal; the system would keep serving the worse price with no error.

**Fix:** fetch both when active, compute each effective price, return whichever
is lower, recomputed every call. Verified live: 20%-off product + 10%-off
category → 80 served; editing the category promo to 60% off → immediately
switched to 40, on both list and detail endpoints.
