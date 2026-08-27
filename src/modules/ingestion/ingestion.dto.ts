import { z } from "zod";

export const createUploadSchema = z.object({
  fileName: z.string().min(1),
});

export type CreateUploadInput = z.infer<typeof createUploadSchema>;
