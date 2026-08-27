import { PrismaClient } from "@prisma/client";

// Single shared client (Prisma manages its own connection pool). In every
// environment this points at the one RDS Postgres instance via RDS Proxy —
// see .env.example for how local development reaches it through an SSM
// tunnel.
export const prisma = new PrismaClient();
