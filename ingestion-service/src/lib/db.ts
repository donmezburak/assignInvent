import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { Pool } from "pg";

const secretsClient = new SecretsManagerClient({});

// Module-scope cache: reused across warm invocations of the same Lambda
// container, so we don't re-fetch the secret or open a fresh connection
// pool on every single batch. RDS Proxy is what makes it safe for many
// concurrent *cold* containers to each hold a small pool without
// exhausting Postgres' own max_connections.
let poolPromise: Promise<Pool> | undefined;

async function buildPool(): Promise<Pool> {
  const secret = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }),
  );
  const { username, password } = JSON.parse(secret.SecretString ?? "{}");

  return new Pool({
    host: process.env.DB_PROXY_ENDPOINT,
    port: 5432,
    database: process.env.DB_NAME,
    user: username,
    password,
    ssl: { rejectUnauthorized: false },
    max: 2, // small per-container pool; RDS Proxy multiplexes across all containers
    idleTimeoutMillis: 30_000,
  });
}

export function getPool(): Promise<Pool> {
  if (!poolPromise) poolPromise = buildPool();
  return poolPromise;
}
