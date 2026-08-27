import { Request, Response } from "express";
import { AppError } from "../../middleware/errorHandler";
import * as ingestionService from "./ingestion.service";

export async function uploadFile(req: Request, res: Response) {
  const fileName = req.header("x-file-name");
  if (!fileName) throw new AppError(400, "MISSING_X_FILE_NAME_HEADER");

  const result = await ingestionService.uploadVendorFile(fileName, req);
  res.status(201).json(result);
}

export async function getStatus(req: Request, res: Response) {
  const job = await ingestionService.getJobStatus(req.params.jobId);
  res.status(200).json(job);
}
