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

  // The LATERAL subqueries reference `p` directly (the same row already
  // fetched by the outer scan) rather than going through a CTE — an earlier
  // version wrapped this in a `WITH active_promo AS (...)` CTE, which forced
  // Postgres to join back to `products` a second time by primary key for
  // every row just to re-expose `p.id`/`p."basePrice"` inside the CTE's own
  // scope. Verified via EXPLAIN ANALYZE against 200k seeded products: this
  // form runs in ~8ms vs ~22ms for the CTE form on a 4,000-row category
  // (Postgres's planner also memoizes the category-promotion lookup here,
  // since every row in a category-filtered page shares the same
  // categoryId). See ADR.md, Scenario B.
  const rows = await prisma.$queryRaw<ProductListRow[]>`
    SELECT
      p.id, p.name, p.sku, p."basePrice", p."stockQuantity", p."categoryId",
      c.name AS "categoryName",
      LEAST(
        COALESCE(direct.price, p."basePrice"),
        COALESCE(cat.price, p."basePrice")
      ) AS "effectivePrice"
    FROM products p
    JOIN categories c ON c.id = p."categoryId"
    LEFT JOIN LATERAL (
      SELECT CASE
        WHEN "discountType" = 'PERCENTAGE' THEN GREATEST(p."basePrice" * (1 - value / 100), 0)
        WHEN "discountType" = 'FIXED' THEN GREATEST(p."basePrice" - value, 0)
      END AS price
      FROM promotions
      WHERE "productId" = p.id AND status = 'ACTIVE'
        AND "startDate" <= now() AND "endDate" >= now()
      LIMIT 1
    ) direct ON true
    LEFT JOIN LATERAL (
      SELECT CASE
        WHEN "discountType" = 'PERCENTAGE' THEN GREATEST(p."basePrice" * (1 - value / 100), 0)
        WHEN "discountType" = 'FIXED' THEN GREATEST(p."basePrice" - value, 0)
      END AS price
      FROM promotions
      WHERE "categoryId" = p."categoryId" AND status = 'ACTIVE'
        AND "startDate" <= now() AND "endDate" >= now()
      LIMIT 1
    ) cat ON true
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
