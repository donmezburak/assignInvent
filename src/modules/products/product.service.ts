import { AppError } from "../../middleware/errorHandler";
import { paginationMeta } from "../../utils/pagination";
import { computeEffectivePrice } from "../pricing/pricing.engine";
import { resolveActivePromotionForProduct } from "../promotions/promotion.service";
import { CreateProductInput, ListProductsQuery } from "./product.dto";
import * as productRepo from "./product.repository";

export async function listProducts(query: ListProductsQuery) {
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
}

export async function getProductById(id: string) {
  const product = await productRepo.findProductById(id);
  if (!product) throw new AppError(404, "PRODUCT_NOT_FOUND");

  const basePrice = Number(product.basePrice);
  const activePromotion = await resolveActivePromotionForProduct(product.id, product.categoryId, basePrice);
  const effectivePrice = computeEffectivePrice(
    basePrice,
    activePromotion ? { discountType: activePromotion.discountType, value: Number(activePromotion.value) } : null,
  );

  return {
    id: product.id,
    name: product.name,
    sku: product.sku,
    basePrice,
    effectivePrice,
    stockQuantity: product.stockQuantity,
    category: { id: product.category.id, name: product.category.name },
  };
}

export function createProduct(input: CreateProductInput) {
  return productRepo.createProduct(input);
}
