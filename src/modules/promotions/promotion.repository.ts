import { Prisma, PromotionScope, PromotionStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";

/**
 * Any ACTIVE promotion in the same scope (product or category) whose date
 * range overlaps the given window. Used to enforce "at most one active
 * promotion at a time" per product/category — see ADR.md for why the check
 * is scoped rather than resolving full cross-scope conflicts up front.
 */
export function findOverlappingActive(
  scope: PromotionScope,
  targetId: string,
  startDate: Date,
  endDate: Date,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
) {
  const scopeFilter = scope === PromotionScope.PRODUCT ? { productId: targetId } : { categoryId: targetId };

  return tx.promotion.findFirst({
    where: {
      ...scopeFilter,
      status: PromotionStatus.ACTIVE,
      startDate: { lt: endDate },
      endDate: { gt: startDate },
    },
  });
}

export function createPromotion(
  data: Prisma.PromotionUncheckedCreateInput,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
) {
  return tx.promotion.create({ data });
}

export function findPromotionById(id: string) {
  return prisma.promotion.findUnique({ where: { id } });
}

export function cancelPromotion(id: string) {
  return prisma.promotion.update({
    where: { id },
    data: { status: PromotionStatus.CANCELLED, cancelledAt: new Date() },
  });
}

/** The currently-active, in-window promotion directly assigned to a product, if any. */
export function findActiveProductPromotion(productId: string, at: Date = new Date()) {
  return prisma.promotion.findFirst({
    where: {
      productId,
      status: PromotionStatus.ACTIVE,
      startDate: { lte: at },
      endDate: { gte: at },
    },
  });
}

/** The currently-active, in-window promotion assigned to a category, if any. */
export function findActiveCategoryPromotion(categoryId: string, at: Date = new Date()) {
  return prisma.promotion.findFirst({
    where: {
      categoryId,
      status: PromotionStatus.ACTIVE,
      startDate: { lte: at },
      endDate: { gte: at },
    },
  });
}

/** Active category promotions for a set of categories, in one round trip (batch resolution for list endpoints). */
export function findActiveCategoryPromotionsForCategories(categoryIds: string[], at: Date = new Date()) {
  if (categoryIds.length === 0) return Promise.resolve([]);
  return prisma.promotion.findMany({
    where: {
      categoryId: { in: categoryIds },
      status: PromotionStatus.ACTIVE,
      startDate: { lte: at },
      endDate: { gte: at },
    },
  });
}
