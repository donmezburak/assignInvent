import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { ListProductsQuery } from "./product.dto";

export type ProductListRow = {
  id: string;
  name: string;
  sku: string;
  basePrice: Prisma.Decimal;
  stockQuantity: number;
  categoryId: string;
  categoryName: string;
  effectivePrice: number;
};

/**
 * Effective price is never stored — it's derived at read time. A product can
 * have both a direct promotion and an active category-wide promotion at
 * once (see promotion.service.ts's conflict check, which only guards
 * against two promotions in the *same* scope) — this picks whichever
 * produces the lower price, mirroring `resolveActivePromotionForProduct`'s
 * logic exactly, so the list and detail endpoints never disagree about
 * which promotion "wins" for a given product.
 *
 * Prisma's query builder can't express "ORDER BY a computed column" or this
 * LATERAL-join shape, so this is raw SQL (parameterized, not
 * string-interpolated) rather than the query builder — see ADR.md.
 */
export async function listProducts(query: ListProductsQuery): Promise<{ rows: ProductListRow[]; total: number }> {
  const offset = (query.page - 1) * query.pageSize;
  const direction = Prisma.raw(query.sortDirection === "desc" ? "DESC" : "ASC");

  const rows = await prisma.$queryRaw<ProductListRow[]>`
    WITH active_promo AS (
      SELECT
        p.id AS product_id,
        CASE
          WHEN direct."discountType" = 'PERCENTAGE' THEN GREATEST(p."basePrice" * (1 - direct.value / 100), 0)
          WHEN direct."discountType" = 'FIXED' THEN GREATEST(p."basePrice" - direct.value, 0)
        END AS direct_price,
        CASE
          WHEN cat."discountType" = 'PERCENTAGE' THEN GREATEST(p."basePrice" * (1 - cat.value / 100), 0)
          WHEN cat."discountType" = 'FIXED' THEN GREATEST(p."basePrice" - cat.value, 0)
        END AS category_price
      FROM products p
      LEFT JOIN LATERAL (
        SELECT "discountType", value FROM promotions
        WHERE "productId" = p.id AND status = 'ACTIVE'
          AND "startDate" <= now() AND "endDate" >= now()
        LIMIT 1
      ) direct ON true
      LEFT JOIN LATERAL (
        SELECT "discountType", value FROM promotions
        WHERE "categoryId" = p."categoryId" AND status = 'ACTIVE'
          AND "startDate" <= now() AND "endDate" >= now()
        LIMIT 1
      ) cat ON true
    )
    SELECT
      p.id, p.name, p.sku, p."basePrice", p."stockQuantity", p."categoryId",
      c.name AS "categoryName",
      LEAST(
        COALESCE(ap.direct_price, p."basePrice"),
        COALESCE(ap.category_price, p."basePrice")
      ) AS "effectivePrice"
    FROM products p
    JOIN categories c ON c.id = p."categoryId"
    LEFT JOIN active_promo ap ON ap.product_id = p.id
    WHERE ${query.categoryId ? Prisma.sql`p."categoryId" = ${query.categoryId}` : Prisma.sql`true`}
    ORDER BY "effectivePrice" ${direction}
    LIMIT ${query.pageSize} OFFSET ${offset}
  `;

  const total = await prisma.product.count({
    where: query.categoryId ? { categoryId: query.categoryId } : undefined,
  });

  return { rows, total };
}

export function findProductById(id: string) {
  return prisma.product.findUnique({ where: { id }, include: { category: true } });
}

export function createProduct(data: Prisma.ProductUncheckedCreateInput) {
  return prisma.product.create({ data });
}
