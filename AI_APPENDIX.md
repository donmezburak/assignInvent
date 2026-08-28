# Form 5 — AI Appendix

## Case study questions — direct answers

**Which AI tools (and models) did I use throughout the process?**
Claude Sonnet 5, via Claude Code (Anthropic's CLI agent), for the entire process — no other AI tool was used.

**The 2 most critical and comprehensive prompts:**

1. *Scenario A — ingestion durability and connection-safety audit:*
   > "Guarantee that every insert performed during ingestion is durable and that
   > concurrent batch processing cannot produce duplicate or miscounted data.
   > Additionally, confirm that a running ingestion job cannot degrade or block
   > normal API users performing routine reads/writes at the same time. if
   > connection exhaustion or contention under concurrent Lambda invocations is
   > possible, correct the connection strategy."

2. *Scenario B — cache stampede under concurrent identical requests:*
   > "If the cache is empty and many identical requests arrive at the same
   > instant. ensure the system doesn't let all of
   > them fall through to the database at once. Add whatever coordination is
   > needed so a cold cache produces at most one real query, not one per
   > concurrent request."

**Error Correction — the biggest architectural/logical mistake (Scenario A):**
The first version of `processBatch` treated a batch as all-or-nothing (one
multi-row `INSERT ... ON CONFLICT`), with a per-attempt catch that marked it
`FAILED` and bumped `failedRows` by 1 on every error. This looked handled but had
three compounding gaps: **(1)** one bad row (e.g. a duplicate SKU within the
batch) failed all ~2,000 rows in it, not just the bad one; **(2)** a batch that
permanently failed after 3 SQS attempts landed in the dead-letter queue with
nothing consuming it or alerting anyone — `processedRows` would just stop
advancing, silently; **(3)** counting failures per-attempt double-counted every
transient error that later succeeded on retry. Steered the fix to: bulk insert
first, fall back to per-row Postgres savepoints on failure (isolates only the
genuinely bad row); a dedicated `handleFailedBatch` Lambda consuming the DLQ as
the *only* place a permanent failure is counted (guarded by `FOR UPDATE`) and
that fires an SNS alert. Verified live: a re-uploaded 500,000-row file produced 0
failures and no duplicate products, and a batch that hit a real Lambda timeout
mid-test was retried and completed correctly with no manual intervention.

The tables below (the official Form 5 template) break this and the rest of the
process down in more detail.

## 1. Tool Manifest

| Model / Tool | Primary Purpose of Use | Effectiveness (1-5) & Brief Why |
|---|---|---|
| Claude Sonnet 5 (via Claude Code CLI) | End-to-end: system design, code generation, real AWS deployment and debugging, live functional/load testing | **5** — the only tool used; it could drive AWS CLI, run local databases, and execute real load tests itself, so every design claim below was verified live rather than left as an assumption. |

## 2. AI Tool Usage Approach

Work went in phases (domain model, Scenario A ingestion, Scenario A hardening,
Scenario B caching); each followed the same pattern — give Claude the business
rule or constraint, let it produce a first design, then test that design against
a concrete adversarial scenario or a real deployment before accepting it. Every
phase surfaced at least one real correction (detailed in the two prompts and the
error correction above).

## 3. Judgement, Challenges & Verification

The recurring challenge was AI output that *looked* complete — a precedence rule,
a try/catch, a cache — without actually holding up under concurrency, scale, or
edited state. Verification was empirical rather than by inspection: real AWS
deploys surfaced account-specific limits (RDS Proxy unavailable, restricted
instance types, a 10-invocation Lambda concurrency cap), load tests measured
actual throughput (~40x improvement from caching), and concurrency tests (many
simultaneous requests) exposed two real race conditions code review alone would
have missed. Every fix was re-verified live before being accepted.

## 4. Overall Reflection

**Estimated ratio:** 60% AI-generated / 40% human-directed correction — most
first-draft code came from the AI, but a large share didn't survive unchanged
without a live verification step catching a real gap.

**Key takeaway:** The main blind spot was code that looks done without a
coherent theory of failure under concurrency. Treating "looks done" as a
hypothesis to test, not a conclusion, is what surfaced every fix above.
