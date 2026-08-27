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

const COLUMNS = ["sku", "name", "category", "basePrice", "stockQuantity"];

/**
 * Processes exactly one batch (~2000 rows). Kept small and self-contained on
 * purpose: this is the invocation that runs hundreds of times per file, so
 * it must stay fast, low-memory, and safe to retry — see ADR.md, Scenario A.
 */
export const handler: SQSHandler = async (event): Promise<SQSBatchResponse> => {
  const pool = await getPool();
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const message: BatchMessage = JSON.parse(record.body);

    try {
      await processOneBatch(pool, message);
    } catch (err) {
      console.error("Batch failed", { message, err });
      await markBatchFailed(pool, message, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};

async function processOneBatch(pool: Awaited<ReturnType<typeof getPool>>, message: BatchMessage) {
  const { jobId, batchIndex, bucket, key, startByte, endByte } = message;

  const existing = await pool.query(
    `SELECT status FROM ingestion_batches WHERE "jobId" = $1 AND "batchIndex" = $2`,
    [jobId, batchIndex],
  );
  // At-least-once delivery: SQS (or a Lambda retry after a timeout) can
  // redeliver a message whose batch already completed successfully. Without
  // this check we'd double-count rowCount into the job's processedRows.
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

    const categoryIds = await upsertCategories(client, [...new Set(rows.map((r) => r.category))]);
    await bulkUpsertProducts(client, rows, categoryIds);

    await client.query(
      `UPDATE ingestion_batches SET status = 'COMPLETED', "rowCount" = $3, "updatedAt" = now()
       WHERE "jobId" = $1 AND "batchIndex" = $2`,
      [jobId, batchIndex, rows.length],
    );

    const jobRow = await client.query(
      `UPDATE ingestion_jobs
         SET "processedRows" = "processedRows" + $2, "updatedAt" = now()
         WHERE id = $1
         RETURNING "processedRows", "totalRows"`,
      [jobId, rows.length],
    );
    const { processedRows, totalRows } = jobRow.rows[0];
    if (processedRows >= totalRows) {
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

async function bulkUpsertProducts(
  client: import("pg").PoolClient,
  rows: VendorRow[],
  categoryIds: Record<string, string>,
) {
  if (rows.length === 0) return;

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

async function markBatchFailed(pool: Awaited<ReturnType<typeof getPool>>, message: BatchMessage, err: unknown) {
  await pool.query(
    `UPDATE ingestion_batches SET status = 'FAILED', "errorSample" = $3, "updatedAt" = now()
     WHERE "jobId" = $1 AND "batchIndex" = $2`,
    [message.jobId, message.batchIndex, String(err).slice(0, 500)],
  );
  await pool.query(`UPDATE ingestion_jobs SET "failedRows" = "failedRows" + 1 WHERE id = $1`, [message.jobId]);
}
