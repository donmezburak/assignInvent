# Promotion Management API

Internal API for product catalog and promotions (seasonal discounts, flash
sales), built as a case study covering product/promotion management, a large-file
vendor ingestion pipeline , and flash-sale read scaling .
See `ADR.md` for architectural decisions and `AI_APPENDIX.md` for the AI usage report.

## Tech stack

- **API:** Node.js, Express, TypeScript, Prisma ORM
- **Database:** PostgreSQL (AWS RDS)
- **Cache:** Redis (AWS ElastiCache) — flash-sale read scaling
- **Ingestion (Scenario A):** AWS Lambda, S3, SQS, SNS — deployed via Serverless Framework (`ingestion-service/`)

## API endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/products` | List products — filter by `categoryId`, paginate (`page`, `pageSize`), sort by effective price (`sortDirection`) |
| GET | `/products/:id` | Single product detail with effective price |
| POST | `/products` | Create a product |
| GET | `/categories` | List categories |
| POST | `/categories` | Create a category |
| POST | `/promotions` | Create a promotion (assigns it to `productId` or `categoryId`) |
| POST | `/promotions/:id/cancel` | Cancel a promotion |
| POST | `/promotions/:id/assign` | Re-target an existing promotion to a different product/category |
| POST | `/ingestion/uploads` | Upload a vendor file (streamed to S3) — triggers Scenario A |
| GET | `/ingestion/jobs/:jobId` | Check an ingestion job's status |

## Running the project

### 1. Deploy the AWS infrastructure

```bash
cd ingestion-service
npm install
npx serverless deploy --stage dev --profile <your-aws-profile>
```

This provisions the VPC, RDS (Postgres), ElastiCache (Redis), S3 bucket, SQS
queues, and the three Lambda functions. Note the stack outputs
(`BastionInstanceId`, `DbInstanceEndpoint`, `DbSecretArn`, `RedisEndpoint`,
`VendorUploadsBucketName`) — you'll need them next.

### 2. Reach the database and cache locally

RDS and ElastiCache are private (no public access). Open SSM tunnels through the
bastion instance from the same stack:

```bash
aws ssm start-session --profile <your-aws-profile> \
  --target <BastionInstanceId> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<DbInstanceEndpoint>"],"portNumber":["5432"],"localPortNumber":["5433"]}'

aws ssm start-session --profile <your-aws-profile> \
  --target <BastionInstanceId> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<RedisEndpoint>"],"portNumber":["6379"],"localPortNumber":["6390"]}'
```

Fetch the DB password once (never stored in the repo):

```bash
aws secretsmanager get-secret-value --profile <your-aws-profile> --secret-id <DbSecretArn>
```

### 3. Configure and run the API

Copy `.env.example` to `.env` and fill in `DATABASE_URL` (URL-encode the password),
`REDIS_URL`, and `INGESTION_BUCKET_NAME` from the values above.

```bash
npm install
npm run prisma:deploy   # applies prisma/migrations to RDS
npm run dev             # starts the API on PORT (default 3000)
```

### 4. Try it

```bash
curl http://localhost:3000/health
curl -X POST http://localhost:3000/categories -H 'Content-Type: application/json' -d '{"name":"Accessories"}'
curl http://localhost:3000/products
```

To test Scenario A, upload a CSV directly to the running API:

```bash
curl -X POST http://localhost:3000/ingestion/uploads \
  -H "X-File-Name: vendor.csv" -H "Content-Type: text/csv" \
  --data-binary @vendor.csv
```
