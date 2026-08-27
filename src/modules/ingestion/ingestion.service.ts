import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { env } from "../../config/env";
import { AppError } from "../../middleware/errorHandler";
import { streamUploadToS3 } from "../../lib/s3";
import { prisma } from "../../lib/prisma";

/**
 * The client's whole interaction is this one call: send the file, get a
 * jobId back. The request body is streamed straight through to S3 (see
 * streamUploadToS3) — this API never holds the file in memory, so the size
 * of a "reasonable" vendor file doesn't threaten this process regardless of
 * how large it gets. `splitFile` (ingestion-service) picks up from here via
 * the S3 event, using the same key convention this generates.
 */
export async function uploadVendorFile(fileName: string, body: Readable) {
  if (!env.ingestionBucket) {
    throw new AppError(500, "INGESTION_BUCKET_NOT_CONFIGURED");
  }

  const jobId = randomUUID();
  const key = `vendor-files/${jobId}/${fileName}`;
  await streamUploadToS3(env.ingestionBucket, key, body);

  return { jobId };
}

export async function getJobStatus(jobId: string) {
  const job = await prisma.ingestionJob.findUnique({ where: { id: jobId } });
  if (!job) throw new AppError(404, "INGESTION_JOB_NOT_FOUND");
  return job;
}
