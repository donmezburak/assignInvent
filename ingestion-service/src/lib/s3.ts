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

/**
 * Streams a CSV object exactly once to find byte offsets that fall cleanly
 * on row boundaries, without ever buffering the whole file in memory —
 * required to stay inside Lambda's memory limit for a 500k-row file. The
 * header row is excluded from every batch's range so `processBatch` can
 * parse each range as headerless, fixed-column CSV.
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

  for await (const chunk of body) {
    const buf = chunk as Buffer;
    let searchFrom = 0;

    for (;;) {
      const idx = buf.indexOf(NEWLINE, searchFrom);
      if (idx === -1) break;

      const lineEndByte = bytesConsumed + idx + 1; // byte offset just past this line's \n
      searchFrom = idx + 1;

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
