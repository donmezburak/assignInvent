import type { SQSHandler } from "aws-lambda";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { getPool } from "../lib/db";

const sns = new SNSClient({});

type BatchMessage = {
  jobId: string;
  batchIndex: number;
};

/**
 * Consumes the dead-letter queue — runs exactly once per batch that has
 * exhausted all 3 delivery attempts on the main queue (see
 * IngestionBatchQueue's RedrivePolicy in serverless.yml). This is the only
 * place `ingestion_jobs.failedRows` gets incremented: doing it inline in
 * `processBatch`'s per-attempt catch would double- or triple-count every
 * transient error that later succeeds on retry. Landing here means the rows
 * in this batch are genuinely never going to be written without manual
 * intervention (inspect `ingestion_batches.errorSample`, fix the data, and
 * redrive the DLQ message), so this also fires an SNS alert instead of
 * failing silently — see ADR.md, Scenario A.
 */
export const handler: SQSHandler = async (event) => {
  const pool = await getPool();

  for (const record of event.Records) {
    const message: BatchMessage = JSON.parse(record.body);
    await recordPermanentFailure(pool, message);
  }
};

async function recordPermanentFailure(pool: Awaited<ReturnType<typeof getPool>>, message: BatchMessage) {
  const client = await pool.connect();
  let expectedRowCount = 0;
  let alreadyRecorded = false;

  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT status, "rowCount" FROM ingestion_batches WHERE "jobId" = $1 AND "batchIndex" = $2 FOR UPDATE`,
      [message.jobId, message.batchIndex],
    );
    const row = existing.rows[0];

    if (!row || row.status === "COMPLETED" || row.status === "FAILED") {
      // Already terminal — either it succeeded on a later attempt before
      // landing here, or this DLQ message is itself a redelivery.
      alreadyRecorded = true;
      await client.query("ROLLBACK");
      return;
    }

    expectedRowCount = row.rowCount ?? 0;

    await client.query(
      `UPDATE ingestion_batches SET status = 'FAILED', "updatedAt" = now()
       WHERE "jobId" = $1 AND "batchIndex" = $2`,
      [message.jobId, message.batchIndex],
    );
    await client.query(
      `UPDATE ingestion_jobs SET "failedRows" = "failedRows" + $2, "updatedAt" = now() WHERE id = $1`,
      [message.jobId, expectedRowCount],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  if (alreadyRecorded) return;

  await sns.send(
    new PublishCommand({
      TopicArn: process.env.ALERTS_TOPIC_ARN,
      Subject: "ModaCo ingestion: batch permanently failed",
      Message: [
        `Job ${message.jobId}, batch ${message.batchIndex} failed 3 delivery attempts and landed in the dead-letter queue.`,
        `~${expectedRowCount} rows were never written to the database.`,
        `Check ingestion_batches.errorSample (jobId=${message.jobId}, batchIndex=${message.batchIndex}) for the last error, fix the underlying data, and redrive the DLQ message to retry.`,
      ].join(" "),
    }),
  );
}
