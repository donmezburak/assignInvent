import { Router } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import * as promotionController from "./promotion.controller";

export const promotionRouter = Router();

// Creating a promotion assigns it to a product or category in the same
// call (productId xor categoryId in the body) — see promotion.dto.ts.
promotionRouter.post("/", asyncHandler(promotionController.create));
promotionRouter.post("/:id/cancel", asyncHandler(promotionController.cancel));
