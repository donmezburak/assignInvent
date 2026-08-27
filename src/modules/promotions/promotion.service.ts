import { PromotionScope, PromotionStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import { CreatePromotionInput } from "./promotion.dto";
import * as promotionRepo from "./promotion.repository";

export async function createPromotion(input: CreatePromotionInput) {
  const scope = input.productId ? PromotionScope.PRODUCT : PromotionScope.CATEGORY;
  const targetId = (input.productId ?? input.categoryId) as string;

  if (scope === PromotionScope.PRODUCT) {
    const product = await prisma.product.findUnique({ where: { id: targetId } });
    if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND");
  } else {
    const category = await prisma.category.findUnique({ where: { id: targetId } });
    if (!category) throw new AppError(404, "CATEGORY_NOT_FOUND");
  }

  // Serialize conflict-check + insert in a transaction so two concurrent
  // "create promotion" requests for the same product/category can't both
  // pass the overlap check and violate "at most one active promotion".
  return prisma.$transaction(async (tx) => {
    const overlapping = await promotionRepo.findOverlappingActive(
      scope,
      targetId,
      input.startDate,
      input.endDate,
      tx,
    );
    if (overlapping) {
      throw new AppError(409, "PROMOTION_CONFLICT", {
        message: "An active promotion already overlaps this date range for the given scope.",
        conflictingPromotionId: overlapping.id,
      });
    }

    return promotionRepo.createPromotion(
      {
        name: input.name,
        discountType: input.discountType,
        value: input.value,
        startDate: input.startDate,
        endDate: input.endDate,
        scope,
        productId: input.productId ?? null,
        categoryId: input.categoryId ?? null,
      },
      tx,
    );
  });
}

export async function cancelPromotion(id: string) {
  const promotion = await promotionRepo.findPromotionById(id);
  if (!promotion) throw new AppError(404, "PROMOTION_NOT_FOUND");
  if (promotion.status === PromotionStatus.CANCELLED) {
    throw new AppError(409, "PROMOTION_ALREADY_CANCELLED");
  }

  return promotionRepo.cancelPromotion(id);
}

/**
 * The promotion that actually applies to a product right now: a
 * product-specific promotion takes precedence over a category-wide one.
 * This is the precedence rule referenced in ADR.md for resolving
 * product-vs-category promotion conflicts.
 */
export async function resolveActivePromotionForProduct(
  productId: string,
  categoryId: string,
  at: Date = new Date(),
) {
  const direct = await promotionRepo.findActiveProductPromotion(productId, at);
  if (direct) return direct;
  return promotionRepo.findActiveCategoryPromotion(categoryId, at);
}
