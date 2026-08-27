import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { Pool } from "pg";

const secretsClient = new SecretsManagerClient({});

// Module-scope cache: reused across warm invocations of the same Lambda
// container, so we don't re-fetch the secret or open a fresh connection
// pool on every single batch.
//
// No RDS Proxy in front of this (unavailable on this AWS account's plan —
// see ADR.md, Scenario A): there's no pooler to absorb a burst of cold
// containers each opening a connection at once. This account's own Lambda
// concurrency ceiling (10 total, account-wide) ends up bounding the number
// of simultaneous direct Postgres connections instead.
let poolPromise: Promise<Pool> | undefined;

async function buildPool(): Promise<Pool> {
  const secret = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }),
  );
  const { username, password } = JSON.parse(secret.SecretString ?? "{}");

  return new Pool({
    host: process.env.DB_HOST,
    port: 5432,
    database: process.env.DB_NAME,
    user: username,
    password,
    ssl: { rejectUnauthorized: false },
    max: 1, // one direct connection per container; the account's concurrency ceiling bounds the total
    idleTimeoutMillis: 30_000,
  });
}

export function getPool(): Promise<Pool> {
  if (!poolPromise) poolPromise = buildPool();
  return poolPromise;
}
