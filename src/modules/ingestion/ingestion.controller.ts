import { Request, Response } from "express";
import { createUploadSchema } from "./ingestion.dto";
import * as ingestionService from "./ingestion.service";

export async function createUpload(req: Request, res: Response) {
  const input = createUploadSchema.parse(req.body);
  const result = await ingestionService.createUpload(input);
  res.status(201).json(result);
}

export async function getStatus(req: Request, res: Response) {
  const job = await ingestionService.getJobStatus(req.params.jobId);
  res.status(200).json(job);
}
