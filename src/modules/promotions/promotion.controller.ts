import { Request, Response } from "express";
import { createPromotionSchema } from "./promotion.dto";
import * as promotionService from "./promotion.service";

export async function create(req: Request, res: Response) {
  const input = createPromotionSchema.parse(req.body);
  const promotion = await promotionService.createPromotion(input);
  res.status(201).json(promotion);
}

export async function cancel(req: Request, res: Response) {
  const promotion = await promotionService.cancelPromotion(req.params.id);
  res.status(200).json(promotion);
}
