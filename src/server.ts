import { app } from "./app";
import { env } from "./config/env";
import { logger } from "./config/logger";

const server = app.listen(env.port, () => {
  logger.info(`ModaCo API listening on port ${env.port}`);
});

// Node's default (5 min) can be too short for a large vendor file streamed
// through POST /ingestion/uploads over a slow connection — see ADR.md.
server.requestTimeout = 15 * 60 * 1000;
