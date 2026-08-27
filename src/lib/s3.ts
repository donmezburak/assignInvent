import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const s3 = new S3Client({});

/**
 * Presigned PUT URL so the client uploads the vendor file straight to S3.
 * The file never passes through this API (or any Lambda) in-line with a
 * request — required given a 500k-row file would blow past both this
 * process's and a Lambda's memory/timeout if proxied. See ADR.md, Scenario A.
 */
export function createUploadUrl(bucket: string, key: string, expiresInSeconds = 300) {
  const command = new PutObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
}
