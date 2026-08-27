import type { SQSBatchResponse, SQSHandler } from "aws-lambda";
import { parse } from "csv-parse/sync";
import { getPool } from "../lib/db";
import { getBatchRange } from "../lib/s3";
import { applyDynamicPricingRules, VendorRow } from "../lib/pricing";

type BatchMessage = {
  jobId: string;
  batchIndex: number;
  bucket: string;
  key: string;
  startByte: number;
  endByte: number;
};

type UpsertResult = {
  succeeded: number;
  failed: { row: VendorRow; error: string }[];
};

const COLUMNS = ["sku", "name", "category", "basePrice", "stockQuantity"];

/**
 * Processes exactly one batch (~2000 rows). Kept small and self-contained on
 * purpose: this is the invocation that runs hundreds of times per file, so
 * it must stay fast, low-memory, and safe to retry — see ADR.md, Scenario A.
 *
 * A per-attempt failure here only logs and lets SQS retry (or eventually
 * dead-letter) the message — it does not touch `failedRows`. Counting a
 * failure here would double-count every transient error that succeeds on a
 * later retry (SQS allows up to 3 attempts before the dead-letter queue).
 * `handleFailedBatch` is the only place that records a *permanent* failure,
 * because it only ever runs once a batch has actually been given up on.
 */
export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const pool = await getPool();
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const message: BatchMessage = JSON.parse(record.body);

    try {
      await processOneBatch(pool, message);
    } catch (err) {
      console.error("Batch attempt failed, will retry via SQS", { message, err });
      await pool
        .query(
          `UPDATE ingestion_batches SET "errorSample" = $3, "updatedAt" = now()
           WHERE "jobId" = $1 AND "batchIndex" = $2`,
          [message.jobId, message.batchIndex, String(err).slice(0, 500)],
        )
        .catch((logErr) => console.error("Failed to record errorSample", logErr));
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

async function processOneBatch(pool: Awaited<ReturnType<typeof getPool>>, message: BatchMessage) {
  const { jobId, batchIndex, bucket, key, startByte, endByte } = message;

  // Fast path only: skips the S3 fetch/parse below for the common case (a
  // batch that already completed on a prior attempt). Not authoritative by
  // itself — two invocations could both pass this check before either
  // commits (e.g. duplicate SQS messages from a re-triggered `splitFile`
  // run processed concurrently). The FOR UPDATE re-check inside the
  // transaction below is what actually closes that race.
  const existing = await pool.query(
    `SELECT status FROM ingestion_batches WHERE "jobId" = $1 AND "batchIndex" = $2`,
    [jobId, batchIndex],
  );
  if (existing.rows[0]?.status === "COMPLETED") {
    console.log("Batch already completed, skipping", { jobId, batchIndex });
    return;
  }

  const rawBody = await getBatchRange(bucket, key, startByte, endByte);
  const chunks: Buffer[] = [];
  for await (const chunk of rawBody) chunks.push(chunk as Buffer);
  const csvText = Buffer.concat(chunks).toString("utf-8");

  const rows: VendorRow[] = parse(csvText, { columns: COLUMNS, cast: true, skip_empty_lines: true }).map(
    (r: Record<string, unknown>) =>
      applyDynamicPricingRules({
        sku: String(r.sku),
        name: String(r.name),
        category: String(r.category),
        basePrice: Number(r.basePrice),
        stockQuantity: Number(r.stockQuantity),
      }),
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Authoritative check: FOR UPDATE locks this one ingestion_batches row
    // for the rest of the transaction — it does not touch products,
    // categories, or any other batch's row, so normal API traffic is
    // unaffected. If a concurrent invocation is processing the same
    // (jobId, batchIndex) right now, its own FOR UPDATE blocks here until
    // this transaction commits or rolls back, then re-reads the
    // now-committed status and finds COMPLETED — closing the race the
    // pre-check above can't close on its own.
    const locked = await client.query(
      `SELECT status FROM ingestion_batches WHERE "jobId" = $1 AND "batchIndex" = $2 FOR UPDATE`,
      [jobId, batchIndex],
    );
    if (locked.rows[0]?.status === "COMPLETED") {
      await client.query("ROLLBACK");
      console.log("Batch already completed (caught under lock), skipping", { jobId, batchIndex });
      return;
    }

    const categoryIds = await upsertCategories(client, [...new Set(rows.map((r) => r.category))]);
    const { succeeded, failed } = await bulkUpsertProducts(client, rows, categoryIds);

    const errorSample =
      failed.length > 0
        ? failed
            .slice(0, 5)
            .map((f) => `${f.row.sku}: ${f.error}`)
            .join(" | ")
            .slice(0, 500)
        : null;

    await client.query(
      `UPDATE ingestion_batches SET status = 'COMPLETED', "rowCount" = $3, "errorSample" = $4, "updatedAt" = now()
       WHERE "jobId" = $1 AND "batchIndex" = $2`,
      [jobId, batchIndex, succeeded, errorSample],
    );

    const jobRow = await client.query(
      `UPDATE ingestion_jobs
         SET "processedRows" = "processedRows" + $2, "failedRows" = "failedRows" + $3, "updatedAt" = now()
         WHERE id = $1
         RETURNING "processedRows", "failedRows", "totalRows"`,
      [jobId, succeeded, failed.length],
    );
    const { processedRows, failedRows, totalRows } = jobRow.rows[0];
    // >= rather than === so a job with isolated (skipped) rows still reaches
    // a terminal state instead of waiting forever for rows that will never
    // arrive.
    if (processedRows + failedRows >= totalRows) {
      await client.query(`UPDATE ingestion_jobs SET status = 'COMPLETED' WHERE id = $1`, [jobId]);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function upsertCategories(
  client: import("pg").PoolClient,
  names: string[],
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const name of names) {
    const result = await client.query(
      `INSERT INTO categories (id, name, "updatedAt") VALUES (gen_random_uuid(), $1, now())
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name],
    );
    map[name] = result.rows[0].id;
  }
  return map;
}

/**
 * Tries the whole batch as one multi-row INSERT first (fast path — one
 * round trip for ~2000 rows). If that fails — e.g. two rows in the same
 * batch share a SKU, which Postgres rejects as "ON CONFLICT DO UPDATE
 * command cannot affect row a second time" — rolls back to the savepoint
 * and retries row by row, each in its own savepoint, so a single bad row
 * can't cost the other ~1999 their write. Without this, one malformed
 * vendor row would fail the entire batch, which would then fail identically
 * on every SQS retry and dead-letter with *all* of its rows unwritten.
 */
async function bulkUpsertProducts(
  client: import("pg").PoolClient,
  rows: VendorRow[],
  categoryIds: Record<string, string>,
): Promise<UpsertResult> {
  if (rows.length === 0) return { succeeded: 0, failed: [] };

  await client.query("SAVEPOINT bulk_upsert");
  try {
    await insertRows(client, rows, categoryIds);
    await client.query("RELEASE SAVEPOINT bulk_upsert");
    return { succeeded: rows.length, failed: [] };
  } catch (bulkErr) {
    await client.query("ROLLBACK TO SAVEPOINT bulk_upsert");
    console.warn("Bulk insert failed, falling back to row-by-row isolation", { error: String(bulkErr) });
    return insertRowsIndividually(client, rows, categoryIds);
  }
}

async function insertRows(
  client: import("pg").PoolClient,
  rows: VendorRow[],
  categoryIds: Record<string, string>,
): Promise<void> {
  const values: string[] = [];
  const params: unknown[] = [];
  rows.forEach((row, i) => {
    const base = i * 5;
    values.push(`(gen_random_uuid(), $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, now())`);
    params.push(row.sku, row.name, row.basePrice, row.stockQuantity, categoryIds[row.category]);
  });

  await client.query(
    `INSERT INTO products (id, sku, name, "basePrice", "stockQuantity", "categoryId", "updatedAt")
     VALUES ${values.join(", ")}
     ON CONFLICT (sku) DO UPDATE SET
       name = EXCLUDED.name,
       "basePrice" = EXCLUDED."basePrice",
       "stockQuantity" = EXCLUDED."stockQuantity",
       "categoryId" = EXCLUDED."categoryId",
       "updatedAt" = now()`,
    params,
  );
}

async function insertRowsIndividually(
  client: import("pg").PoolClient,
  rows: VendorRow[],
  categoryIds: Record<string, string>,
): Promise<UpsertResult> {
  const failed: { row: VendorRow; error: string }[] = [];
  let succeeded = 0;

  for (const row of rows) {
    await client.query("SAVEPOINT row_upsert");
    try {
      await insertRows(client, [row], categoryIds);
      await client.query("RELEASE SAVEPOINT row_upsert");
      succeeded += 1;
    } catch (rowErr) {
      await client.query("ROLLBACK TO SAVEPOINT row_upsert");
      failed.push({ row, error: String(rowErr).slice(0, 200) });
    }
  }

  return { succeeded, failed };
}
