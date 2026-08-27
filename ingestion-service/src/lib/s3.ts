import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";

export const s3 = new S3Client({});

export type BatchRange = {
  batchIndex: number;
  startByte: number;
  endByte: number; // exclusive
  rowCount: number;
};

export type SplitResult = {
  totalRows: number;
  batches: BatchRange[];
};

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const QUOTE = 0x22;

/**
 * Streams a CSV object exactly once to find byte offsets that fall cleanly
 * on row boundaries, without ever buffering the whole file in memory —
 * required to stay inside Lambda's memory limit for a 500k-row file. The
 * header row is excluded from every batch's range so `processBatch` can
 * parse each range as headerless, fixed-column CSV.
 *
 * Tracks whether we're inside a quoted field (RFC 4180: a quoted field can
 * contain literal commas and newlines) and only treats a `\n` as a row
 * boundary when we're not. A `""` escaped-quote pair toggles the flag twice
 * in a row, netting no change — so plain quote-toggling handles escaping
 * correctly without needing to special-case it. Without this, a vendor row
 * like `"Multi\nLine Description"` would get its embedded newline mistaken
 * for a row boundary, splitting one row into two corrupt ones.
 *
 * Also counts a final row that has no trailing newline (the file simply
 * ends after it) — many export tools omit the last line's newline, and
 * without this that entire last row would be silently uncounted: not in
 * any batch, not in `totalRows`, never processed, and nothing would ever
 * flag it as missing.
 *
 * Batch ranges are recorded (not the rows themselves): each batch is
 * re-fetched from S3 by the batch worker via an HTTP Range request, which
 * keeps this function's own memory footprint at "one chunk at a time".
 */
export async function computeBatchRanges(
  bucket: string,
  key: string,
  batchSize: number,
): Promise<SplitResult> {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = object.Body as Readable;

  const batches: BatchRange[] = [];
  let bytesConsumed = 0;
  let rowsInCurrentBatch = 0;
  let totalRows = 0;
  let batchStartByte = -1;
  let sawHeader = false;
  let inQuotes = false;
  let sawContentSinceBoundary = false;

  for await (const chunk of body) {
    const buf = chunk as Buffer;

    for (let i = 0; i < buf.length; i++) {
      const byte = buf[i];

      if (byte === QUOTE) {
        inQuotes = !inQuotes;
        sawContentSinceBoundary = true;
        continue;
      }
      if (byte !== NEWLINE || inQuotes) {
        if (byte !== CARRIAGE_RETURN) sawContentSinceBoundary = true;
        continue;
      }

      const lineEndByte = bytesConsumed + i + 1; // byte offset just past this line's \n
      sawContentSinceBoundary = false;

      if (!sawHeader) {
        sawHeader = true;
        batchStartByte = lineEndByte;
        continue;
      }

      rowsInCurrentBatch += 1;
      totalRows += 1;

      if (rowsInCurrentBatch === batchSize) {
        batches.push({
          batchIndex: batches.length,
          startByte: batchStartByte,
          endByte: lineEndByte,
          rowCount: rowsInCurrentBatch,
        });
        batchStartByte = lineEndByte;
        rowsInCurrentBatch = 0;
      }
    }

    bytesConsumed += buf.length;
  }

  if (sawContentSinceBoundary) {
    rowsInCurrentBatch += 1;
    totalRows += 1;
  }

  if (rowsInCurrentBatch > 0) {
    batches.push({
      batchIndex: batches.length,
      startByte: batchStartByte,
      endByte: bytesConsumed,
      rowCount: rowsInCurrentBatch,
    });
  }

  return { totalRows, batches };
}

/** Fetches one batch's raw (headerless) CSV bytes via an S3 Range request. */
export async function getBatchRange(bucket: string, key: string, startByte: number, endByte: number): Promise<Readable> {
  const object = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=${startByte}-${endByte - 1}` }),
  );
  return object.Body as Readable;
}
