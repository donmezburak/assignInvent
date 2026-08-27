import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { logger } from "./config/logger";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";
import { categoryRouter } from "./modules/categories/category.routes";
import { ingestionRouter } from "./modules/ingestion/ingestion.routes";
import { productRouter } from "./modules/products/product.routes";
import { promotionRouter } from "./modules/promotions/promotion.routes";

export const app = express();

app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(pinoHttp({ logger }));

app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

app.use("/products", productRouter);
app.use("/promotions", promotionRouter);
app.use("/categories", categoryRouter);
app.use("/ingestion", ingestionRouter);

app.use(notFoundHandler);
app.use(errorHandler);
