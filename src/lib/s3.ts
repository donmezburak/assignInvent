import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";

export const s3 = new S3Client({});

/**
 * Streams `body` straight to S3 without ever buffering the whole file in
 * this process's memory — `Upload` handles S3's multipart upload protocol
 * (chunking, retries) internally, so this stays memory-flat regardless of
 * file size. This is what lets a single "just upload the file" endpoint
 * accept a large vendor file without reintroducing the memory risk Scenario
 * A's serverless ingestion pipeline is built to avoid — see ADR.md.
 */
export async function streamUploadToS3(bucket: string, key: string, body: Readable): Promise<void> {
  const upload = new Upload({
    client: s3,
    params: { Bucket: bucket, Key: key, Body: body },
  });
  await upload.done();
}
