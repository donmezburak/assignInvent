import { randomUUID } from "node:crypto";
import { env } from "../../config/env";
import { AppError } from "../../middleware/errorHandler";
import { createUploadUrl } from "../../lib/s3";
import { prisma } from "../../lib/prisma";
import { CreateUploadInput } from "./ingestion.dto";

/**
 * Issues a presigned upload URL and the key convention that `splitFile`
 * (ingestion-service) parses to recover the job id — see
 * ingestion-service/src/handlers/splitFile.ts. No `ingestion_jobs` row is
 * created here: it doesn't exist until `splitFile` actually runs, so job
 * status is "not found" until the file has actually landed in S3.
 */
export async function createUpload(input: CreateUploadInput) {
  if (!env.ingestionBucket) {
    throw new AppError(500, "INGESTION_BUCKET_NOT_CONFIGURED");
  }

  const jobId = randomUUID();
  const key = `vendor-files/${jobId}/${input.fileName}`;
  const uploadUrl = await createUploadUrl(env.ingestionBucket, key);

  return { jobId, uploadUrl, key };
}

export async function getJobStatus(jobId: string) {
  const job = await prisma.ingestionJob.findUnique({ where: { id: jobId } });
  if (!job) throw new AppError(404, "INGESTION_JOB_NOT_FOUND");
  return job;
}
