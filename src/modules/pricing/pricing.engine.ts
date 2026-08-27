import { DiscountType } from "@prisma/client";

export type PromotionLike = {
  discountType: DiscountType;
  value: number;
};

/**
 * Pure function applying a single promotion to a base price. Used by the
 * read path (GET /products effective price); ingestion-service has its own
 * copy of the dynamic-pricing-rules half of this (see its ADR note) since
 * it's a separately deployed Lambda bundle.
 */
export function computeEffectivePrice(basePrice: number, promotion: PromotionLike | null): number {
  if (!promotion) return round2(basePrice);

  const raw =
    promotion.discountType === DiscountType.PERCENTAGE
      ? basePrice * (1 - promotion.value / 100)
      : basePrice - promotion.value;

  return round2(Math.max(0, raw));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
