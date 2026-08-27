import { prisma } from "../../lib/prisma";
import { CreateCategoryInput } from "./category.dto";

export function listCategories() {
  return prisma.category.findMany({ orderBy: { name: "asc" } });
}

export function createCategory(input: CreateCategoryInput) {
  return prisma.category.create({ data: input });
}
