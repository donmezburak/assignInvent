import { Router } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import * as promotionController from "./promotion.controller";

export const promotionRouter = Router();

// Creating a promotion also assigns it to a product or category in the same
// call (productId xor categoryId in the body) — see promotion.dto.ts. The
// separate /assign endpoint below is for re-targeting an *existing*
// promotion (e.g. moving it from one product to another, or from a product
// to a whole category) without recreating it.
promotionRouter.post("/", asyncHandler(promotionController.create));
promotionRouter.post("/:id/cancel", asyncHandler(promotionController.cancel));
promotionRouter.post("/:id/assign", asyncHandler(promotionController.assign));
