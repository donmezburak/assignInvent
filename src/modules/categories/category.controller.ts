import { Request, Response } from "express";
import { createCategorySchema } from "./category.dto";
import * as categoryService from "./category.service";

export async function list(_req: Request, res: Response) {
  const categories = await categoryService.listCategories();
  res.status(200).json(categories);
}

export async function create(req: Request, res: Response) {
  const input = createCategorySchema.parse(req.body);
  const category = await categoryService.createCategory(input);
  res.status(201).json(category);
}
