import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  ingestionBucket: process.env.INGESTION_BUCKET_NAME,
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),
  cacheTtlListSeconds: Number(process.env.CACHE_TTL_LIST_SECONDS ?? 10),
  cacheTtlActivePromoSeconds: Number(process.env.CACHE_TTL_ACTIVE_PROMO_SECONDS ?? 30),
  cacheTtlDetailSeconds: Number(process.env.CACHE_TTL_DETAIL_SECONDS ?? 30),
};
