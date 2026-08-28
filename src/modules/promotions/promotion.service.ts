import { PromotionScope, PromotionStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../middleware/errorHandler";
import {
  activePromoCategoryKey,
  activePromoProductKey,
  bumpVersion,
  cacheDelete,
  cacheGetOrSet,
  CATALOG_LIST_VERSION_KEY,
} from "../../lib/redis";
import { env } from "../../config/env";
import { computeEffectivePrice } from "../pricing/pricing.engine";
import { AssignPromotionInput, CreatePromotionInput } from "./promotion.dto";
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
  const promotion = await prisma.$transaction(async (tx) => {
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

  await invalidateFor(scope, targetId);
  return promotion;
}

export async function cancelPromotion(id: string) {
  const promotion = await promotionRepo.findPromotionById(id);
  if (!promotion) throw new AppError(404, "PROMOTION_NOT_FOUND");
  if (promotion.status === PromotionStatus.CANCELLED) {
    throw new AppError(409, "PROMOTION_ALREADY_CANCELLED");
  }

  const cancelled = await promotionRepo.cancelPromotion(id);
  await invalidateFor(promotion.scope, (promotion.productId ?? promotion.categoryId) as string);
  return cancelled;
}

/**
 * Re-targets an existing promotion to a different product or category —
 * distinct from `createPromotion`, per the case study's explicit "create,
 * cancel, and assign" wording. Re-runs the same overlap check as creation
 * (against the *new* target), excluding the promotion's own row so
 * reassigning it to the target it already occupies isn't flagged as
 * conflicting with itself.
 */
export async function assignPromotion(id: string, input: AssignPromotionInput) {
  const promotion = await promotionRepo.findPromotionById(id);
  if (!promotion) throw new AppError(404, "PROMOTION_NOT_FOUND");
  if (promotion.status === PromotionStatus.CANCELLED) {
    throw new AppError(409, "PROMOTION_CANCELLED", { message: "Cannot reassign a cancelled promotion." });
  }

  const scope = input.productId ? PromotionScope.PRODUCT : PromotionScope.CATEGORY;
  const targetId = (input.productId ?? input.categoryId) as string;

  if (scope === PromotionScope.PRODUCT) {
    const product = await prisma.product.findUnique({ where: { id: targetId } });
    if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND");
  } else {
    const category = await prisma.category.findUnique({ where: { id: targetId } });
    if (!category) throw new AppError(404, "CATEGORY_NOT_FOUND");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const overlapping = await promotionRepo.findOverlappingActive(
      scope,
      targetId,
      promotion.startDate,
      promotion.endDate,
      tx,
      id,
    );
    if (overlapping) {
      throw new AppError(409, "PROMOTION_CONFLICT", {
        message: "An active promotion already overlaps this date range for the given scope.",
        conflictingPromotionId: overlapping.id,
      });
    }

    return promotionRepo.assignPromotionTarget(id, scope, input.productId ?? null, input.categoryId ?? null, tx);
  });

  // Both the old target (which no longer has this promotion) and the new
  // target (which now does) need their cached active-promotion entry
  // dropped.
  await invalidateFor(promotion.scope, (promotion.productId ?? promotion.categoryId) as string);
  await invalidateFor(scope, targetId);
  return updated;
}

async function invalidateFor(scope: PromotionScope, targetId: string) {
  // List results (sorted by effective price) can shift for any promotion
  // change, and list cache keys can't be enumerated to delete individually
  // — so bump the shared version instead (see lib/redis.ts).
  await bumpVersion(CATALOG_LIST_VERSION_KEY);

  // The active-promotion cache, by contrast, has exactly one entry for this
  // exact product/category, so a direct delete is precise and cheap — this
  // is what keeps "50% off Accessories" from having to touch 50,000 rows or
  // cache keys: only this single key changes.
  const key = scope === PromotionScope.PRODUCT ? activePromoProductKey(targetId) : activePromoCategoryKey(targetId);
  await cacheDelete(key);
}

/**
 * The promotion that actually applies to a product right now. A product can
 * simultaneously have both a direct promotion and an active category-wide
 * promotion (the conflict check only prevents two promotions in the *same*
 * scope from overlapping — see `createPromotion`) — when both exist, this
 * picks whichever produces the lower effective price for the customer,
 * recomputed fresh on every call. That matters because a category
 * promotion can be edited after a product promotion was created and become
 * the better deal, or vice versa; a fixed "product always wins" rule would
 * keep applying the worse discount until someone noticed. See ADR.md.
 *
 * Cached per product and per category (not per product alone) — during a
 * flash sale, every one of the 50,000 affected products resolves to the
 * *same* `promo:active:category:{id}` cache entry, so this stays a single
 * hot key instead of 50,000 independent ones.
 */
export async function resolveActivePromotionForProduct(
  productId: string,
  categoryId: string,
  basePrice: number,
  at: Date = new Date(),
) {
  const [direct, category] = await Promise.all([
    cacheGetOrSet(activePromoProductKey(productId), env.cacheTtlActivePromoSeconds, () =>
      promotionRepo.findActiveProductPromotion(productId, at),
    ),
    cacheGetOrSet(activePromoCategoryKey(categoryId), env.cacheTtlActivePromoSeconds, () =>
      promotionRepo.findActiveCategoryPromotion(categoryId, at),
    ),
  ]);

  if (!direct) return category;
  if (!category) return direct;

  const directPrice = computeEffectivePrice(basePrice, { discountType: direct.discountType, value: Number(direct.value) });
  const categoryPrice = computeEffectivePrice(basePrice, {
    discountType: category.discountType,
    value: Number(category.value),
  });

  return directPrice <= categoryPrice ? direct : category;
}
