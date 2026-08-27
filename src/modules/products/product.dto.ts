import { z } from "zod";

export const listProductsQuerySchema = z.object({
  categoryId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sortDirection: z.enum(["asc", "desc"]).default("asc"),
});

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export const createProductSchema = z.object({
  name: z.string().min(1),
  sku: z.string().min(1),
  basePrice: z.number().positive(),
  stockQuantity: z.number().int().min(0),
  categoryId: z.string().uuid(),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
