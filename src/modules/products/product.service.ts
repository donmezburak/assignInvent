import { env } from "../../config/env";
import { AppError } from "../../middleware/errorHandler";
import { paginationMeta } from "../../utils/pagination";
import { bumpVersion, cacheGetOrSet, CATALOG_LIST_VERSION_KEY, getOrInitVersion, productCoreKey } from "../../lib/redis";
import { computeEffectivePrice } from "../pricing/pricing.engine";
import { resolveActivePromotionForProduct } from "../promotions/promotion.service";
import { CreateProductInput, ListProductsQuery } from "./product.dto";
import * as productRepo from "./product.repository";

export async function listProducts(query: ListProductsQuery) {
  const version = await getOrInitVersion(CATALOG_LIST_VERSION_KEY);
  const cacheKey = `products:list:v${version}:${query.categoryId ?? "all"}:${query.page}:${query.pageSize}:${query.sortDirection}`;

  const result = await cacheGetOrSet(cacheKey, env.cacheTtlListSeconds, async () => {
    const { rows, total } = await productRepo.listProducts(query);
    return {
      items: rows.map((row) => ({
        id: row.id,
        name: row.name,
        sku: row.sku,
        basePrice: Number(row.basePrice),
        effectivePrice: Number(row.effectivePrice),
        stockQuantity: row.stockQuantity,
        category: { id: row.categoryId, name: row.categoryName },
      })),
      meta: paginationMeta(total, query),
    };
  });

  return result!;
}

export async function getProductById(id: string) {
  const core = await cacheGetOrSet(productCoreKey(id), env.cacheTtlDetailSeconds, async () => {
    const product = await productRepo.findProductById(id);
    if (!product) return null;
    return {
      id: product.id,
      name: product.name,
      sku: product.sku,
      basePrice: Number(product.basePrice),
      stockQuantity: product.stockQuantity,
      category: { id: product.category.id, name: product.category.name },
    };
  });

  if (!core) throw new AppError(404, "PRODUCT_NOT_FOUND");

  const activePromotion = await resolveActivePromotionForProduct(core.id, core.category.id, core.basePrice);
  const effectivePrice = computeEffectivePrice(
    core.basePrice,
    activePromotion ? { discountType: activePromotion.discountType, value: Number(activePromotion.value) } : null,
  );

  return { ...core, effectivePrice };
}

export async function createProduct(input: CreateProductInput) {
  const product = await productRepo.createProduct(input);
  // A newly created product changes what every cached list page should
  // contain; there's no per-product list entry to delete, so bump the
  // shared version instead (same mechanism as promotion invalidation).
  await bumpVersion(CATALOG_LIST_VERSION_KEY);
  return product;
}
