import { z } from "zod";

export const createPromotionSchema = z
  .object({
    name: z.string().min(1),
    discountType: z.enum(["PERCENTAGE", "FIXED"]),
    value: z.number().positive(),
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
    productId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
  })
  .refine((data) => data.endDate > data.startDate, {
    message: "endDate must be after startDate",
    path: ["endDate"],
  })
  .refine((data) => Boolean(data.productId) !== Boolean(data.categoryId), {
    message: "Exactly one of productId or categoryId must be provided",
    path: ["productId"],
  })
  .refine((data) => data.discountType !== "PERCENTAGE" || data.value <= 100, {
    message: "Percentage discount value cannot exceed 100",
    path: ["value"],
  });

export type CreatePromotionInput = z.infer<typeof createPromotionSchema>;
