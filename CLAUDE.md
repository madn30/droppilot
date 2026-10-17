# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DropPilot is an automated dropshipping system: it imports CJ Dropshipping products, matches them to identical competitor listings, scores demand, prices and lists them on eBay (Amazon optional), syncs price/stock, fulfils orders and runs a seasonal engine. `README.md` is detailed and accurate (pipeline, pricing formula, going live, per-service key setup, worker schedule); read the relevant section before changing a domain.

Stack: Next.js 15 (App Router, Server Actions) + a separate BullMQ worker process, PostgreSQL/Prisma, Redis, Zod 4, pino, Vitest.

## Commands

```bash
npm run dev                 # dashboard on :3000
npm run worker              # background worker (separate process; needs Redis)
npm run typecheck           # tsc --noEmit
npm run lint
npm test                    # unit tests, no services needed
npx vitest run src/server/pricing/engine.test.ts      # one file
npx vitest run -t "name fragment"                     # one test by name
npm run test:integration    # needs Postgres (docker compose up -d postgres); uses separate droppilot_test DB
npm run db:migrate          # prisma migrate dev (create a migration)
npm run db:deploy           # apply migrations
npm run db:seed             # settings defaults, CJ supplier, US holiday calendar
npm run match -- CJ-NECKLACE-001    # import + match + score one product (mock reference product)
npm run check:live          # one read-only call per configured API key
npm run try:supplier -- "<keyword>" # dry-run supplier side against real services; lists/orders nothing
```

Docker Compose maps Postgres to host port 5433 (`POSTGRES_PORT`), Redis 6379, app 3000 (`APP_PORT`). Production runs via `docker-compose.prod.yml` (app, worker, Postgres, Redis, Caddy). Tests need `DATABASE_URL` etc.; the vitest configs inject them, so no `.env` is required for `npm test`.

## Architecture

**Two processes, one codebase.** The Next.js app (`src/app`, `src/features`) handles UI and Server Actions; the worker (`src/worker`) runs BullMQ jobs (queues/job names in `src/worker/queues.ts`: matching, seasonal + trending discovery, sync, orders/tracking/account-health). Both import the domain logic in `src/server`. Business logic lives in `src/server/<domain>`; `src/features/<name>` holds the per-page `queries.ts`, `actions.ts` (`"use server"`, call `requireAdmin()` first), and components. Pages in `src/app/(dashboard)` stay thin. Auth is a single admin from env (`src/server/auth`).

**Adapter + mock seam (the key pattern).** Every external service sits behind an interface with a real and a mock implementation, chosen by a factory that checks `getEnv().MOCK_APIS`: `suppliers/`, `marketplaces/` (eBay, Amazon), `data-sources/` (Google Trends via SerpApi, sales rank via Keepa/SP-API), `ai/` (Anthropic API or `claude-cli` per `AI_PROVIDER`, Jina CLIP embeddings). Mock data comes from `src/server/mocks/fixtures` (the necklace reference scenario). Mock mode is the default and runs the whole pipeline with no keys; in mock mode the app and worker each hold their own in-memory fake marketplace/supplier, so state changes aren't shared between processes. Live mode fails fast naming any missing key.

**Dependency injection for services.** Domain runners (`matching/run-matching.ts`, `listing/service.ts`, `demand/run-demand.ts`, ...) take a deps object; `deps.ts` in each domain builds the real/mock collaborators plus current settings. Unit tests pass fakes directly; follow this when adding a domain service.

**Pipeline flow:** `catalog/import-product` → `matching` (candidates, pHash/CLIP image score, spec score with hard-reject rules, optional vision check, `final-score`; manual approve/reject overrides persist) → `demand` score → `listing` (Claude copy, `pricing/engine`, `compliance/guards`) → `sync` + `repricer` → `orders` (ingest, fulfil, tracking) → `alerts` / `health`. `seasonal/` and `discovery/` feed products into the same pipeline.

**Settings** are a single JSON row validated by `settings/schema.ts` (Zod) and merged over `defaultSettings(env)` in `settings/service.ts`, so adding a setting needs a default and old rows keep working. Env is validated in `server/env.ts`.

**Compliance rules are enforced in code** (`server/compliance/guards.ts`: dropship-only suppliers, Amazon blind shipping/US warehouse, delivery-within-promise, trademark blocklist, listing limits). Orders are never auto-cancelled. Buyer addresses are stored encrypted (`server/crypto.ts`); eBay account-deletion notices are handled in `server/privacy` and `src/app/api/ebay/account-deletion`.

**eBay specifics:** a product's sellable variants become one multi-variation listing (`listing/variations.ts`, `listing/` grouping via `listingGroupKey`); descriptions are built in `marketplaces/ebay/description.ts` (limits learned by testing are documented in README). eBay and Amazon clients are tested against a fake HTTP layer only.

## Deploying

Production runs on one always-on Linux server (`<server-ip>`, reached with `ssh root@<server-ip>`) serving `https://<domain>` through Caddy, including the eBay account-deletion endpoint. The real address, SSH key and current state are in the untracked `CLAUDE.local.md`.

The server has no git remote: code is copied from the local repo with rsync into `/opt/droppilot`, then `docker compose -f docker-compose.prod.yml up -d --build` runs there. Never overwrite the server's `.env` (it has `DOMAIN`, `POSTGRES_PASSWORD` and the eBay deletion-endpoint values the local one lacks), so exclude it along with `node_modules`, `.next`, `.git` and `storage`. Dry-run the rsync (`-n`) first to see what changes. On the server run migrations only with `prisma migrate deploy`, never `migrate dev`.

## Testing conventions

Unit tests sit beside the code (`*.test.ts`) under `src/`; `tests/integration/` holds the end-to-end reference scenario on mock adapters against real Postgres (files run serially, shared DB). The `@` alias maps to `src`.
