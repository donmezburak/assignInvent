import { NextFunction, Request, Response } from "express";

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Forwards rejected promises from async route handlers to Express's error middleware. */
export const asyncHandler = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => {
  handler(req, res, next).catch(next);
};
