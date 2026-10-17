# DropPilot

An automated dropshipping system. It finds supplier products with real demand, matches each one to listings of the **exact same product** sold by competitors, prices it, lists it on eBay and Amazon, keeps price and stock in sync with the supplier, fulfils orders, and pushes seasonal products ahead of each holiday.

Stack: Next.js 15 (App Router, Server Actions), PostgreSQL + Prisma, Redis + BullMQ (a separate worker process), Zod, pino, Vitest, Tailwind + shadcn/ui.

## Contents

- [Run it locally (mock mode)](#run-it-locally-mock-mode)
- [How it works](#how-it-works)
- [Compliance rules enforced in code](#compliance-rules-enforced-in-code)
- [Going live](#going-live)
- [Getting each API key](#getting-each-api-key)
- [Scripts and tests](#scripts-and-tests)
- [Project layout](#project-layout)
- [Known limits](#known-limits)

## Run it locally (mock mode)

Mock mode (`MOCK_APIS=true`, the default) serves every external API from built-in fixtures, so the whole pipeline runs without any keys. Requires Node 22+ and Docker.

```bash
cp .env.example .env
# fill in the three secrets:
npm run auth:hash -- '<your password>'   # → ADMIN_PASSWORD_HASH
openssl rand -base64 32                   # → SESSION_SECRET
openssl rand -base64 32                   # → ENCRYPTION_KEY

npm install
docker compose up -d postgres redis
npm run db:deploy      # apply migrations
npm run db:seed        # settings defaults, CJ supplier, US holiday calendar
npm run dev            # dashboard on http://localhost:3000
npm run worker         # background worker (separate process)
```

Then, to see the reference product go through the pipeline:

```bash
npm run match -- CJ-NECKLACE-001   # import, match against competitors A–H, score demand
```

Open **Matches** (D and F confirmed, H awaiting review), **Products** (demand score and trend), and create a listing from the Products page; it waits on **Listings** for your approval.

To run everything in containers instead: `docker compose up --build`. The image build needs about 2 GB of free Docker memory. Host ports are configurable: `POSTGRES_PORT` (default 5433), `REDIS_PORT` (6379), `APP_PORT` (3000).

In mock mode the app and the worker each hold their own in-memory fake marketplace and supplier, so a price or stock change you simulate in one process is not seen by the other.

## How it works

### 1. Supplier

Products come from CJ Dropshipping through an adapter interface (`src/server/suppliers/types.ts`), so another dropshipping supplier can be added later. Importing a product stores its variants with cost, shipping cost, warehouse, processing days and delivery days, and caches up to 10 images. The warehouse is chosen in this order: the destination country's own, then US/EU, then the rest; within that, fastest then cheapest.

### 2. Pricing

```
floor = (cost + shipping + MIN_PROFIT + fixed fee) / (1 − marketplace fee − payment fee − returns buffer)
```

The supplier cost is first inflated by the price buffer (3% by default) so a small supplier increase does not push a listing under its floor. Prices end in .89 or .99 and never go below the floor. All fees, buffers and margins are in **Settings**.

### 3. Exact-product matching

A competitor listing counts only when it is the exact same product. For each supplier variant the matcher:

1. searches eBay (by image and keyword) and Amazon (by keyword) for candidates;
2. compares every supplier image with every competitor image (pHash first, CLIP embeddings otherwise) and scores the share of supplier images with a strong match;
3. extracts specs (material, shape, size, colour, personalization, gift box, pack quantity) and rejects any listing that differs on material, shape, personalization, gift box or pack quantity, or whose size is more than 10% off;
4. asks Claude vision about the top four image pairs when that can still change the outcome;
5. combines the three into a final score: 85% and up is confirmed, 60–85% goes to **Matches → Needs review**, the rest is discarded.

Your approve/reject decisions override the algorithm and survive re-runs. A variant with no confirmed competitor is "unique" and is priced by margin target. Matching re-runs for every active variant on Mondays at 03:00 UTC, and earlier for any variant whose daily marketplace search shows a listing it has not been matched against.

### 4. Demand

Every variant gets a 0–100 score built only from its confirmed matches, as a weighted mix (weights in Settings) of sales velocity (Amazon sales rank, 90-day eBay sold quantities from Marketplace Insights when enabled, the supplier's trending list), trend direction (five-year Google Trends interest via SerpApi), competition, profit margin and delivery speed. Google Trends values are relative interest (0–100): they are used for direction, the yearly peak month and related rising queries, and never treated as sales. A product is eligible for auto-listing at or above the demand threshold.

### 5. Listings and repricing

- **Creating a listing** generates the title and description with Claude, prices it, and checks the compliance rules below. With manual approve on (the default) it waits on the **Listings** page until you publish it.
- **Repricer** strategies per variant: `cheapest`, `match`, `slightly_below` (default) and `premium` (above the market, only when we deliver fastest). It compares total price (item + shipping) and ignores sellers rated under 80% or more than a week slower than us. When a competitor is under our floor the listing stays at the floor or pauses, per Settings.
- **Sync** refreshes supplier cost and stock for every live listing every two hours (30 minutes for top sellers), re-prices, sets quantity 0 when the supplier is out of stock and resumes when stock returns.
- On **eBay**, a product's sellable variants (in stock, deliverable in time) go into **one listing with options** the buyer picks, such as colour, each with its own SKU, price and stock. Only attributes that differ between the variants become options. Approving, rejecting and ending act on the whole listing; sync and repricing work per option. A listing with options counts once against the listing limit. Amazon keeps one listing per variant.
- eBay listings state the supplier's US warehouse as item location, so by default only US-warehouse stock is listed on eBay (Settings → Listing → "eBay: US warehouse only"). Amazon is always US-only.
- eBay listings carry the supplier's photos (up to 24) and an HTML description laid out like a store page: title, our text, the facts as a specifications table, the pictures from the supplier's description, and an information block that states the handling time and points to eBay's own shipping, returns and payment details. One eBay limit found by testing: with a description over 4,000 characters, the photo URLs may add up to about 1,250 characters at most, so the last photos are left out when needed.
- On **eBay**, publishing reads the item specifics the category requires and fills the missing ones: Brand is "Unbranded", MPN is "Does Not Apply", an allowed value the title or description names is used as is, and the AI picks the rest (from eBay's list when eBay restricts the values). If one is still unanswered, the listing is not published and the error names it.
- On **Amazon**, when a confirmed match is an Amazon listing, our listing joins that ASIN as an additional offer. Otherwise a new product is submitted under the brand "Generic".

### 6. Seasonal engine

The US holiday calendar is seeded with keywords, a 60-day listing window and a successor holiday. Every day at 04:00 UTC the seasonal job:

1. pauses listings whose cut-off has passed (processing + delivery + 2 days before the holiday);
2. two days after a holiday, strips its words from titles and re-targets listings to its successor (Valentine's Day → Mother's Day), or ends them when there is none;
3. for holidays inside their window, searches the supplier with the holiday keywords, imports, matches and scores the results, and lists the top N on eBay.

**Trending discovery** runs every day at 06:00 UTC and needs no keyword. It takes the supplier's trending products that are stocked in the destination country, skips those scored in the last 7 days, imports, matches and scores the next few (Settings → Discovery, 5 by default), and lists the best ones above the demand threshold on eBay (3 by default). They are created as drafts awaiting approval while "manual approve" is on. Set "Trending products evaluated per day" to 0 to turn it off.

### 7. Orders

Every 10 minutes the worker fetches new paid orders and re-checks the supplier's current price and stock:

- still profitable, or a loss within the max acceptable loss ($1 by default): the supplier order is placed with the buyer's address and its id saved;
- a bigger loss: nothing is ordered and you get an alert. On the **Orders** page you can fulfil anyway, record that you fulfilled it with another supplier, or record that you cancelled it on the marketplace;
- out of stock, address rejected or any other supplier refusal: the order is marked failed and you get an alert, with a Retry button.

An order whose items ship from different supplier warehouses becomes one supplier order per warehouse; it is marked shipped once every parcel has its tracking uploaded.

**Paying the supplier.** By default supplier orders are paid from the supplier balance (CJ wallet), which CJ only tops up from Payoneer, WorldFirst or a wire transfer. With Settings → Orders → "Pay supplier orders from balance" off, each order is created at the supplier unpaid and you get a "Pay the supplier" alert with the amount; you pay it at the supplier by card or PayPal, and the alert closes when the supplier reports the order paid or shipped.

Orders are **never cancelled automatically**. Every 30 minutes the worker checks supplier shipments and uploads each tracking number to the marketplace, which marks the order shipped. Buyer addresses are stored encrypted.

### 8. Alerts and account health

Alerts appear on the Overview page and are sent by email and Telegram when those are configured. They cover orders that need you, account health, and background jobs that keep failing.

Once a day the worker records each marketplace's metrics. It warns when a metric has used 80% of its limit and raises a critical alert past it; while any metric is close to its limit, new listings on that marketplace are refused (switchable in Settings). Limits: Amazon order defect rate under 1%, late shipment under 4%, cancellation under 2.5%, valid tracking over 95%; eBay transaction defect rate under 2%.

**Commands in Telegram.** When the Telegram alert URL is a bot's `sendMessage` URL, the worker also listens to that chat. Alerts carry buttons (approve or reject a draft, retry an order, "I paid it"), and you can type: `status`, `drafts`, `approve <id>`, `reject <id>`, `orders`, `retry <id>`, `fulfil <id>`, `handled <id>`, `cancelled <id>`, `paid <id>`, `alerts`, `help`. Only the chat id in that URL is obeyed; messages from any other chat are ignored.

## Compliance rules enforced in code

| Rule | Where |
| --- | --- |
| Dropshipping suppliers only, never retail arbitrage | `assertDropshipSupplier` on import and on every listing |
| Amazon: supplier must ship blind (no supplier branding or invoices) | `assertBlindShippingForAmazon` |
| Amazon: listings ship from a United States warehouse only | `assertUsWarehouseForAmazon` |
| Never list a product whose delivery exceeds the marketplace promise | `assertDeliveryWithinPromise` (days per marketplace in Settings) |
| eBay: realistic handling time | the listing uses the tightest fulfillment policy that covers the supplier's processing days; none → no listing |
| No brand names or trademarks in titles or descriptions | the copy prompt forbids them; `assertNoTrademarks` blocks a list of well-known marks |
| New accounts: 20 live listings, configurable weekly growth | `assertListingLimit` |
| Official APIs only: no scraping of Amazon, eBay or Google | every source is an API client in `src/server` |
| Orders are never auto-cancelled | nothing in the code cancels a marketplace order |

## Going live

1. Get the keys below and put them in `.env`. CJ, eBay, SerpApi and Jina are required, plus either an Anthropic API key or `AI_PROVIDER=claude-cli`. **Amazon is optional**: leave all `SPAPI_` keys empty and DropPilot runs on eBay alone; add them later to switch Amazon on. **Keepa is optional** too.
2. Run `npm run check:live`. It makes one small read-only call to every service whose key is set and tells you what works, what fails and what is missing. It works while `MOCK_APIS` is still `true`, so you can test keys one at a time.
3. Clear the mock data: `npx prisma migrate reset` (wipes the database and re-seeds settings and holidays). Mock listings and orders would otherwise be synced against the real marketplaces and fail.
4. Set `MOCK_APIS=false` and restart `npm run dev` and `npm run worker`. In live mode DropPilot stops with a message naming any key that is missing.
5. Keep `EBAY_ENV=sandbox` and `CJ_SANDBOX_ORDERS=true` for the first runs. eBay then uses its sandbox, and supplier orders are CJ sandbox orders that are never charged or shipped. Amazon has no sandbox setting here: its listings and orders are real from the start.
6. Leave **manual approve** on in Settings until you trust the listings it drafts.
7. When you are ready for real orders: `EBAY_ENV=production` (with production eBay keys) and `CJ_SANDBOX_ORDERS=false`. Supplier orders are then paid from your CJ balance.

CJ Dropshipping, SerpApi, Jina and the Claude CLI have been run against the live services and corrected where the real responses differed from the documentation. eBay and Amazon have not: their clients were written from the published API schemas and are tested against a fake HTTP layer. Expect small mismatches on first contact there, and start with one product.

## Getting each API key

### Admin login and secrets

| Variable | How |
| --- | --- |
| `ADMIN_EMAIL` | the email you will sign in with |
| `ADMIN_PASSWORD_HASH` | `npm run auth:hash -- '<password>'` and paste the output |
| `SESSION_SECRET` | `openssl rand -base64 32` |
| `ENCRYPTION_KEY` | `openssl rand -base64 32` (encrypts API tokens and buyer addresses; changing it later makes stored ones unreadable) |

### CJ Dropshipping — `CJ_API_KEY`

1. Create an account at cjdropshipping.com and sign in.
2. Open **My CJ → Authorization → API** and generate an API key.
3. Put it in `CJ_API_KEY`. DropPilot exchanges it for access tokens itself and stores them encrypted.
4. Top up your CJ balance before turning off `CJ_SANDBOX_ORDERS`: orders are paid from it.
5. Ask your CJ agent to confirm that your orders ship without CJ branding, invoices or prices in the parcel. DropPilot sends that request as an order remark; CJ has no API switch for it.

### eBay — `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_REFRESH_TOKEN`, `EBAY_ENV`

1. Join the eBay Developers Program at developer.ebay.com with your seller account.
2. Under **Application Keys**, create a keyset. The **App ID** is `EBAY_CLIENT_ID` and the **Cert ID** is `EBAY_CLIENT_SECRET`. Sandbox and Production have separate keysets; use the one that matches `EBAY_ENV`. A production keyset is only enabled after you answer eBay's marketplace account deletion notification requirement (subscribe an endpoint or apply for the exemption).
3. Next to the keyset, open **User Tokens → Get a Token from eBay via Your Application**. Add a redirect URL; eBay gives it a name (the **RuName**).
4. With the client ID and secret in `.env`, run `npm run ebay:token -- url <RuName>`. Open the URL it prints and sign in as the seller. It requests the scopes DropPilot needs (`sell.inventory`, `sell.account`, `sell.fulfillment`, `sell.analytics.readonly`).
5. eBay redirects to your redirect URL with `?code=…` in the address bar. Copy the code and run `npm run ebay:token -- exchange <RuName> '<code>'`. It prints the `EBAY_REFRESH_TOKEN` line for `.env` (valid for 18 months). Keep the quotes: the token contains `#`, which otherwise starts a comment. The code expires after a few minutes.
6. In the seller account, opt in to **business policies** (a sandbox test user has no Seller Hub; opt in with `POST /sell/account/v1/program/opt_in` and `{"programType":"SELLING_POLICY_MANAGEMENT"}`, and use the generic `ShippingMethodStandard` service in its fulfillment policies) and create a payment policy, a return policy, and a fulfillment policy whose handling time is at least your supplier's processing days (for example 3 business days).
7. Create one inventory location (Seller Hub, or `POST /sell/inventory/v1/location/{key}`).

**Going to production.** eBay keeps a production keyset disabled until the application handles *marketplace account deletion*: when a member closes their eBay account, eBay notifies every application, which must erase that member's data. DropPilot stores buyer names and addresses, so it does not qualify for the exemption; it implements the process at `/api/ebay/account-deletion`:

1. Run the app where eBay can reach it over HTTPS (a server with a domain, not your own computer).
2. Choose a verification token of 32 to 80 letters, digits, `_` or `-`. Set `EBAY_VERIFICATION_TOKEN` to it and `EBAY_DELETION_ENDPOINT` to `https://<your domain>/api/ebay/account-deletion`, then restart the app.
3. At developer.ebay.com, open the production keyset's **Notifications**, choose Marketplace Account Deletion, and enter the same endpoint and token. eBay calls the endpoint with a challenge; DropPilot answers it and eBay enables the keyset.
4. From then on each notice is checked against eBay's signature and the buyer's name and address are removed from their orders (amounts and items are kept). Only orders stored after this was added carry the buyer's username.
5. Put the production App ID and Cert ID in `.env`, set `EBAY_ENV=production`, and get a refresh token with `npm run ebay:token` by signing in with your real seller account. That account needs business policies and an inventory location, as above.

**Running on a server.** `docker-compose.prod.yml` runs the built app, the worker, PostgreSQL, Redis and Caddy (HTTPS, certificate obtained and renewed automatically); only ports 80 and 443 are published. Copy the project and a `.env` to the server, add `DOMAIN` (the host name pointing at the server) and `POSTGRES_PASSWORD` to that `.env`, and run `docker compose -f docker-compose.prod.yml up -d --build`. Migrations are applied with `prisma migrate deploy` at start. Never run `prisma migrate dev` or `prisma migrate reset` against a database whose data you want to keep. With `AI_PROVIDER=claude-cli`, the image has the Claude CLI and signs in with `CLAUDE_CODE_OAUTH_TOKEN` (create it with `claude setup-token`).

**eBay Marketplace Insights** (sold data) is a restricted API that eBay grants on request, with its own OAuth scope (`buy.marketplace.insights`). Until your application has it, leave "eBay Marketplace Insights" off in Settings; with it on and no access, demand scoring fails.

### Amazon SP-API — `SPAPI_LWA_CLIENT_ID`, `SPAPI_LWA_CLIENT_SECRET`, `SPAPI_REFRESH_TOKEN`, `SPAPI_SELLER_ID`, `SPAPI_REGION`

1. You need a Professional selling account on amazon.com.
2. In Seller Central open **Apps and Services → Develop Apps** and register as a developer for a **private** application. Request the roles for product listing, pricing, inventory and order tracking, and direct-to-consumer shipping (the restricted role that allows reading buyer shipping addresses).
3. Create an app client. Its **LWA credentials** are `SPAPI_LWA_CLIENT_ID` and `SPAPI_LWA_CLIENT_SECRET`.
4. On the app, choose **Authorize** to self-authorize it for your seller account. The refresh token it shows is `SPAPI_REFRESH_TOKEN`.
5. `SPAPI_SELLER_ID` is your **Merchant Token**: Seller Central → Settings → Account Info → Your Merchant Token.
6. `SPAPI_REGION` is `na` for amazon.com.
7. For products that are not already on Amazon, apply for a **GTIN exemption** for the brand "Generic" in the categories you sell in. Without it, only listings that join an existing ASIN will be accepted.

### Keepa — `KEEPA_API_KEY` (optional)

Keepa is a paid subscription and is not needed. Without a key, the sales rank of Amazon matches is read from Amazon's own catalog API, which is free with your seller account and gives the current rank; demand scoring only uses the current rank. Keepa is used instead when a key is set:

1. Create an account at keepa.com and subscribe to API access.
2. Your key is shown on the API page of your account (keepa.com/#!api).

### SerpApi (Google Trends) — `SERPAPI_KEY`

1. Sign up at serpapi.com.
2. Copy the API key from your dashboard.

Each product uses two searches per week (interest over time and related queries).

### AI provider — `AI_PROVIDER`, `ANTHROPIC_API_KEY`

Claude does three jobs: spec extraction (one call per new or changed competitor listing), photo checks (only for listings that pass the hard rules) and listing copy. Choose how it is reached:

- **`AI_PROVIDER=claude-cli`** runs the `claude` command installed on this machine, on the Claude subscription it is signed in to. No API key and no per-call charge, but calls count against that subscription's usage limits, each takes a few seconds, and the app and worker must run on a machine where `claude` is installed and signed in (so not inside the Docker containers). The model is set in `src/server/ai/claude-cli/runner.ts` (Sonnet).
- **`AI_PROVIDER=anthropic-api`** (the default) uses the Anthropic API, billed per call. Sign in to the Claude Console, add billing, create a key under **API keys** and set `ANTHROPIC_API_KEY`. The model is set in `src/server/ai/anthropic/client.ts`.

Both use the same prompts. With the CLI, listing text never gets tools to act with, and photo checks may only read a temporary folder holding the image pairs.

### Jina AI (image embeddings) — `EMBEDDINGS_PROVIDER_KEY`

1. Sign up at jina.ai and create an API key.

Used for CLIP embeddings (`jina-clip-v2`), one per product or competitor image, stored after the first time. Another provider can be plugged in by implementing `EmbeddingsProvider`.

### Telegram alerts — `TELEGRAM_WEBHOOK_URL`

1. In Telegram, talk to **@BotFather**, send `/newbot` and note the bot token.
2. Send your new bot any message, then open `https://api.telegram.org/bot<token>/getUpdates` and note `message.chat.id`.
3. Set `TELEGRAM_WEBHOOK_URL=https://api.telegram.org/bot<token>/sendMessage?chat_id=<chat id>`.

Any URL that accepts `POST {"text": "…"}` works.

### Email alerts — `SMTP_URL`, `ALERT_EMAIL_TO`

Use your mail provider's SMTP details as a URL, for example `smtps://user:password@smtp.example.com:465`, and the address that should receive alerts.

## Scripts and tests

| Script | What it does |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js app |
| `npm run worker` | BullMQ worker |
| `npm test` | Unit tests (no services needed) |
| `npm run test:integration` | Tests against Postgres (`docker compose up -d postgres`); uses a separate `droppilot_test` database |
| `npm run typecheck` / `lint` | TypeScript and ESLint |
| `npm run db:migrate` / `db:deploy` / `db:seed` | Prisma migrations and seed |
| `npm run auth:hash -- '<password>'` | Hash an admin password for `.env` |
| `npm run check:live` | Test every configured API key with one read-only call (`-- --notify` also sends a test alert) |
| `npm run ebay:token -- url\|exchange …` | Get the eBay refresh token |
| `npm run try:supplier -- "<keyword>"` | Dry-run the supplier side against the real CJ, Jina and Claude services: search, product, stock, US shipping quotes, images, specs (`--trends` adds Google Trends). Lists and orders nothing |
| `npm run match -- <supplier product id>` | Import one supplier product, then match it and score its demand |

`tests/integration/scenario.test.ts` runs the reference scenario end to end on mock adapters: the Custom Photo Projection Necklace is discovered, matched (D and F confirmed, H in review, the rest rejected), listed at $24.89, re-priced after a $1 supplier increase, sold on Feb 3 (auto-ordered, tracking uploaded), paused on Feb 8 for the Valentine's cut-off and re-targeted to Mother's Day on Feb 16.

### Worker schedule

| Job | When |
| --- | --- |
| Order polling | every 10 minutes (Settings) |
| Supplier sync and repricing | each listing every 2 hours, top sellers every 30 minutes |
| Tracking | every 30 minutes |
| Seasonal job | daily, 04:00 UTC |
| Trending discovery | daily, 06:00 UTC |
| Account health | daily, 05:00 UTC |
| Check for new competitor listings | daily, 02:00 UTC |
| Re-matching and demand scoring | Mondays, 03:00 UTC |

## Project layout

- `src/app` — pages: overview, products, matches, listings, orders, seasonal, settings, login
- `src/features` — server actions, queries and components per dashboard area
- `src/server` — env, db, auth, settings, pricing, matching, demand, repricer, listing, sync, orders, seasonal, health, alerts, compliance, and the adapters (`suppliers`, `marketplaces`, `data-sources`, `ai`) with their mocks
- `src/worker` — BullMQ worker, queues and jobs
- `prisma` — schema, migrations, seed
- `tests/integration` — tests that need Postgres

## Known limits

- The eBay and Amazon clients are untested against the live services (see [Going live](#going-live)).
- Discovery only considers supplier products stocked in the destination country (the US): overseas stock would miss the delivery promise.
- New Amazon products (no existing ASIN) are submitted with the attributes DropPilot has. Amazon rejects the submission when the product type requires more; the reasons are shown and nothing is created.
- Seasonal auto-listing creates eBay listings only; Amazon listings are created from the Products page.
- The marketplace is the US for both eBay and Amazon, and prices are in USD.
- Processing time is assumed (3 days, 7 for personalized items) because CJ's API does not report it.
- The daily check for new competitor listings uses keyword search only; a listing that only an image search would find waits for the weekly run.
- The eBay Marketplace Insights call was written without access to its (restricted) documentation and has not been run.
