import { Router } from "express";
import { asyncHandler } from "../../middleware/asyncHandler";
import * as productController from "./product.controller";

export const productRouter = Router();

productRouter.get("/", asyncHandler(productController.list));
productRouter.get("/:id", asyncHandler(productController.getById));
productRouter.post("/", asyncHandler(productController.create));
