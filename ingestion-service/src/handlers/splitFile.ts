import type { S3Handler } from "aws-lambda";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { getPool } from "../lib/db";
import { computeBatchRanges } from "../lib/s3";

const sqs = new SQSClient({});
const BATCH_SIZE = Number(process.env.INGESTION_BATCH_SIZE ?? 2000);

/**
 * Triggered once per uploaded vendor file (S3 ObjectCreated). Expects keys
 * shaped `vendor-files/{jobId}/{originalFileName}` — the main API generates
 * `jobId` (a UUID) when it issues the presigned upload URL, so this handler
 * never has to invent identifiers or guess at idempotency keys.
 *
 * This function does the one pass over the file that *must* happen in a
 * single invocation (finding row-aligned byte offsets); everything after
 * that — actually parsing and pricing rows — is fanned out to `processBatch`
 * so no single invocation ever has to hold more than one batch in memory.
 */
export const handler: S3Handler = async (event) => {
  const pool = await getPool();

  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    const [, jobId, ...nameParts] = key.split("/");
    const fileName = nameParts.join("/");

    const { totalRows, batches } = await computeBatchRanges(bucket, key, BATCH_SIZE);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // ON CONFLICT guards against S3's at-least-once delivery re-triggering
      // this handler for the same upload.
      await client.query(
        `INSERT INTO ingestion_jobs (id, "fileName", "filePath", status, "totalRows", "totalBatches", "updatedAt")
         VALUES ($1, $2, $3, 'PROCESSING', $4, $5, now())
         ON CONFLICT (id) DO NOTHING`,
        [jobId, fileName, key, totalRows, batches.length],
      );

      for (const batch of batches) {
        await client.query(
          `INSERT INTO ingestion_batches (id, "jobId", "batchIndex", "startByte", "endByte", "rowCount", status, "updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'PENDING', now())
           ON CONFLICT ("jobId", "batchIndex") DO NOTHING`,
          [jobId, batch.batchIndex, batch.startByte, batch.endByte, batch.rowCount],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    for (const batch of batches) {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: process.env.BATCH_QUEUE_URL,
          MessageBody: JSON.stringify({
            jobId,
            batchIndex: batch.batchIndex,
            bucket,
            key,
            startByte: batch.startByte,
            endByte: batch.endByte,
          }),
        }),
      );
    }
  }
};
