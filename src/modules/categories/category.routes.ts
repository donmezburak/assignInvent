import { Router } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import * as categoryController from "./category.controller";

export const categoryRouter = Router();

categoryRouter.get("/", asyncHandler(categoryController.list));
categoryRouter.post("/", asyncHandler(categoryController.create));
