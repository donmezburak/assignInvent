import { Request, Response } from "express";
import { createProductSchema, listProductsQuerySchema } from "./product.dto";
import * as productService from "./product.service";

export async function list(req: Request, res: Response) {
  const query = listProductsQuerySchema.parse(req.query);
  const result = await productService.listProducts(query);
  res.status(200).json(result);
}

export async function getById(req: Request, res: Response) {
  const product = await productService.getProductById(req.params.id);
  res.status(200).json(product);
}

export async function create(req: Request, res: Response) {
  const input = createProductSchema.parse(req.body);
  const product = await productService.createProduct(input);
  res.status(201).json(product);
}
