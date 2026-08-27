// Mirrors the pure pricing-rule logic in src/modules/pricing/pricing.engine.ts
// in the main API. Kept as a small, dependency-free copy here rather than a
// shared package so the Lambda bundle stays minimal — see ADR.md for why the
// ingestion service doesn't pull in the main API's Prisma-based codebase.

export type VendorRow = {
  sku: string;
  name: string;
  category: string;
  basePrice: number;
  stockQuantity: number;
};

export function applyDynamicPricingRules(row: VendorRow): VendorRow {
  const basePrice = Math.max(0.01, Math.round(row.basePrice * 100) / 100);
  return { ...row, basePrice };
}
