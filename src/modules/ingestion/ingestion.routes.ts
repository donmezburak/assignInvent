import { Router } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import * as ingestionController from "./ingestion.controller";

export const ingestionRouter = Router();

ingestionRouter.post("/uploads", asyncHandler(ingestionController.uploadFile));
ingestionRouter.get("/jobs/:jobId", asyncHandler(ingestionController.getStatus));
