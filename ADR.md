# Architecture Decision Record — ModaCo Promotion Management API

## 1. Overview

- **Stack:** Node.js, Express, TypeScript, Prisma, PostgreSQL (AWS RDS), Redis (AWS ElastiCache).
- **Single database**, no local/prod split — main API and the ingestion pipeline share one RDS instance (private; local dev via SSM tunnel).
- **Two deployables:** `/` (REST API, long-running Express) and `/ingestion-service` (Serverless Framework: Lambda + S3 + SQS + SNS, Scenario A).

## 2. Domain model (1)

- **Category is a table, not a string** — promotions need a real FK to target "an entire category," and Scenario B needs a stable join target for new products.
- **Effective price is never stored.** Resolved at read time, always. This means Scenario A ingestion never touches promotions (no join, no lookup), and Scenario B's category promotions never require updating the products they affect (single `INSERT`, no write amplification).
- **"At most one active promotion":**
  - *Same scope* (two product or two category promotions) overlapping in date → rejected with `409` inside a transaction.
  - *Cross scope* (a product promotion + its category's promotion, both active) → allowed by design; `resolveActivePromotionForProduct` computes both and returns whichever gives the **lower price**, recomputed every call. Earlier version had "product always wins," which silently keeps the worse discount if the category promo is later edited to be better — corrected during review (see `AI_APPENDIX.md`). Verified live.
- **Separate `assign` endpoint** (`POST /promotions/:id/assign`) re-targets an existing promotion — the case study asks for "create, cancel, **and assign**" as distinct capabilities.

## 3. Scenario A — Massive Data Ingestion

**Constraint:** strict timeout, restricted memory, stateless between invocations. One function reading/writing the whole 500k-row file fails all three.

- **Upload:** `POST /ingestion/uploads` streams the raw request body straight to S3 (`@aws-sdk/lib-storage`), never buffering it — measured ~64KB RSS change for a 27MB file. Chosen over a presigned-URL round trip for a single-call client experience, at the cost of the upload occupying an API connection for its duration.
- **Split:** `splitFile` (one invocation/file) streams the object once, computing byte-aligned batch ranges (~2,000 rows each) without holding row data in memory (133MB used / 512MB limit). Two real bugs fixed here: a naive newline scan broke on quoted fields containing embedded newlines, and silently dropped the file's last row when it lacked a trailing newline — both corrected with a quote-aware, EOF-aware scanner.
- **Process:** `processBatch` fetches its byte range, applies `applyDynamicPricingRules` in memory *before* any write (the case study's core requirement), then bulk-upserts. Bulk insert first; on failure, falls back to per-row savepoints so one bad row doesn't cost its other ~1,999. Idempotent via a pre-check plus `SELECT ... FOR UPDATE` on the batch's own row (closes a redelivery race without locking `products` or other batches).
- **Stateless, proven live:** all progress lives in `ingestion_jobs`/`ingestion_batches`, never Lambda memory. In a real run, one batch's Lambda hit its own timeout under DB contention, died mid-work, and a fresh container picked it up correctly after SQS's visibility timeout — no data lost, no manual fix.
- **Permanent failures are visible:** after 3 SQS attempts, a batch lands in a DLQ consumed by `handleFailedBatch` — the *only* place `failedRows` is incremented (counting inline would double-count retries that later succeed) — which also fires an SNS alert.
- **RDS Proxy** was the original plan for connection pooling; unavailable on this AWS account's plan. My account own Lambda concurrency cap (10) substitutes as the connection guard — correctness holds, but a 500k-row run takes minutes here instead of the tens of seconds it would on an unrestricted account.
- **Live results:** 500k rows via direct S3 upload — 52s, 0 failures. Via the streaming API endpoint — ~3m21s (one batch retried after a timeout), 0 failures. Re-uploading the same 500k SKUs still produced exactly 500,000 products (upsert, not duplication).

## 4. Scenario B — Flash Sales

**Correctness needs no caching.** A category promotion is one row; a new product in that category reads the same row on its first request — verified live, no cache involved.

**The measured bottleneck:** uncached list endpoint plateaued at ~250 req/s regardless of concurrency (728ms→3.7s latency, 200→1,000 connections) — a saturation signature (the query itself runs in ~8ms after removing a redundant self-join separately), pointing to the API's small connection pool as the real limit.

**Cache-aside, two invalidation strategies:**
- List cache — keys can't be enumerated, so a shared version counter is embedded in every key; one `INCR` invalidates all pages at once.
- Active-promotion cache (per product/category) — exactly one key per target, so invalidation is a direct `DEL`: a 50,000-product flash sale costs one Redis write.
- Product-core cache (highest-traffic endpoint) — short TTL only; no invalidation hook from the ingestion Lambdas (separate deployable, no shared Redis client).

**Stampede protection:** invalidating a category's cache means the *next* request could be thousands, all missing at once. `cacheGetOrSet` uses a Redis lock (`SET NX PX`) so only the first caller queries Postgres; the rest poll the cache; a bounded timeout prevents an indefinite hang if the lock holder dies. Verified live: 50 concurrent requests to a cold key → exactly 1 DB query, 50 correct responses.

**Results (measured, same data before/after):**

| | Uncached | Cached | Improvement |
|---|---|---|---|
| 200 conns, latency / throughput | 728ms / ~260 req/s | 18ms / ~10,200 req/s | ~40x |
| 1,000 conns, latency / throughput | 3.7s / ~227 req/s | 76ms / ~8,400 req/s | ~49x |

Correctness+speed re-verified at a real 50,000-product single category (66ms first page, 92ms worst-case deep page — offset pagination's known cost, accepted since the spec only asks for pagination, not cursor-based). Deployed to real AWS ElastiCache and functionally re-verified there; the load test itself wasn't rerun through the SSM tunnel (would understate real in-VPC performance).

**A write-side race, not just reads:** the case study asks about "simultaneous heavy read *and write*" — two truly concurrent `POST /promotions` for the same product both succeeded in 5/5 trials, violating "at most one active promotion." Root cause: check-then-insert in one transaction isn't safe across two *concurrent* transactions under READ COMMITTED. Fixed with `pg_advisory_xact_lock(hashtext(targetId))`, acquired before the check — locks the id itself even with no row to `FOR UPDATE` yet. Re-verified: 5/5 trials now produce exactly one winner. See `AI_APPENDIX.md`.

**Still open:** caching removed the DB as the bottleneck, but the API is still a single process with no horizontal scaling — the next ceiling, not proven away. Scaling out would need no design change (Redis/Postgres are already the shared state).

## 5. Cross-cutting trade-offs

| Decision | Why | Cost |
|---|---|---|
| No RDS Proxy | Unavailable on my account's plan | Lambda concurrency cap substitutes as the connection guard |
| Raw SQL for product listing | Prisma can't express `ORDER BY` a computed cross-table value | Loses query-builder type-safety there; mitigated with a typed return shape |
| Streaming upload vs. presigned URL | Single client call | File bytes pass through the API process (streamed, not buffered) |
| Redis cache-aside vs. denormalized price / materialized view | Instant, cheap invalidation (one key delete) | Bounded staleness on TTL entries; adds Redis as an operational dependency |
