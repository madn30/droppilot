-- CreateEnum
CREATE TYPE "Marketplace" AS ENUM ('EBAY', 'AMAZON');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DISCOVERED', 'MATCHING', 'ELIGIBLE', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('CONFIRMED', 'REVIEW', 'REJECTED');

-- CreateEnum
CREATE TYPE "DecidedBy" AS ENUM ('AUTO', 'USER');

-- CreateEnum
CREATE TYPE "ListingStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'PAUSED', 'ENDED', 'ERROR');

-- CreateEnum
CREATE TYPE "PauseReason" AS ENUM ('OUT_OF_STOCK', 'BELOW_FLOOR', 'HOLIDAY_CUTOFF', 'DELIVERY_PROMISE', 'ACCOUNT_HEALTH', 'MANUAL');

-- CreateEnum
CREATE TYPE "RepricerStrategy" AS ENUM ('CHEAPEST', 'MATCH', 'SLIGHTLY_BELOW', 'PREMIUM');

-- CreateEnum
CREATE TYPE "PriceChangeReason" AS ENUM ('INITIAL', 'REPRICE', 'SUPPLIER_COST', 'SEASONAL', 'FLOOR', 'MANUAL');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('NEW', 'NEEDS_DECISION', 'ORDERED', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "SupplierOrderStatus" AS ENUM ('PENDING', 'PLACED', 'SHIPPED', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDropshipSupplier" BOOLEAN NOT NULL DEFAULT true,
    "supportsBlindShipping" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "isPersonalized" BOOLEAN NOT NULL DEFAULT false,
    "specs" JSONB,
    "status" "ProductStatus" NOT NULL DEFAULT 'DISCOVERED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "attributes" JSONB NOT NULL,
    "costCents" INTEGER NOT NULL,
    "shippingCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "warehouse" TEXT NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "processingDays" INTEGER NOT NULL,
    "deliveryDaysMin" INTEGER NOT NULL,
    "deliveryDaysMax" INTEGER NOT NULL,
    "isUnique" BOOLEAN NOT NULL DEFAULT false,
    "repricerStrategy" "RepricerStrategy" NOT NULL DEFAULT 'SLIGHTLY_BELOW',
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT,
    "url" TEXT NOT NULL,
    "localPath" TEXT,
    "position" INTEGER NOT NULL,
    "pHash" TEXT,
    "embedding" DOUBLE PRECISION[],

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorListing" (
    "id" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT,
    "priceCents" INTEGER NOT NULL,
    "shippingCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "deliveryDays" INTEGER,
    "sellerRating" DOUBLE PRECISION,
    "soldCount" INTEGER,
    "itemSpecifics" JSONB,
    "extractedSpecs" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorImage" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "pHash" TEXT,
    "embedding" DOUBLE PRECISION[],

    CONSTRAINT "CompetitorImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMatch" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "competitorListingId" TEXT NOT NULL,
    "imageScore" DOUBLE PRECISION NOT NULL,
    "matchedImageCount" INTEGER NOT NULL,
    "specScore" DOUBLE PRECISION NOT NULL,
    "hardRuleFailures" TEXT[],
    "visionVerdict" JSONB,
    "finalScore" DOUBLE PRECISION NOT NULL,
    "status" "MatchStatus" NOT NULL,
    "decidedBy" "DecidedBy" NOT NULL DEFAULT 'AUTO',
    "decidedAt" TIMESTAMP(3),
    "lastEvaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemandSnapshot" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "components" JSONB NOT NULL,
    "competitorCount" INTEGER NOT NULL,
    "lowestCompetitorCents" INTEGER,
    "salesRank" INTEGER,
    "soldLast30d" INTEGER,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemandSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrendSnapshot" (
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "keyword" TEXT NOT NULL,
    "geo" TEXT NOT NULL DEFAULT 'US',
    "direction" TEXT NOT NULL,
    "peakMonth" INTEGER,
    "series" JSONB NOT NULL,
    "relatedQueries" JSONB,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrendSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Holiday" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'US',
    "dateRule" TEXT NOT NULL,
    "keywords" TEXT[],
    "categories" TEXT[],
    "listStartDaysBefore" INTEGER NOT NULL DEFAULT 60,
    "endAfterDays" INTEGER NOT NULL DEFAULT 2,
    "retargetToCode" TEXT,
    "autoListTopN" INTEGER NOT NULL DEFAULT 5,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "externalId" TEXT,
    "sku" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "floorCents" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "status" "ListingStatus" NOT NULL DEFAULT 'DRAFT',
    "pauseReason" "PauseReason",
    "holidayId" TEXT,
    "cutoffDate" TIMESTAMP(3),
    "isTopSeller" BOOLEAN NOT NULL DEFAULT false,
    "lastRepricedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "floorCents" INTEGER NOT NULL,
    "costCents" INTEGER NOT NULL,
    "reason" "PriceChangeReason" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "externalId" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'NEW',
    "buyerName" TEXT NOT NULL,
    "shippingAddress" JSONB NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "orderedAt" TIMESTAMP(3) NOT NULL,
    "shipByDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "externalLineId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "priceCents" INTEGER NOT NULL,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplierOrder" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "externalId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "SupplierOrderStatus" NOT NULL DEFAULT 'PENDING',
    "costCents" INTEGER NOT NULL,
    "shippingCents" INTEGER NOT NULL,
    "expectedProfitCents" INTEGER NOT NULL,
    "blindShipping" BOOLEAN NOT NULL,
    "trackingNumber" TEXT,
    "carrier" TEXT,
    "trackingUploadedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplierOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackingEvent" (
    "id" TEXT NOT NULL,
    "supplierOrderId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountHealth" (
    "id" TEXT NOT NULL,
    "marketplace" "Marketplace" NOT NULL,
    "lateShipmentRate" DOUBLE PRECISION NOT NULL,
    "cancellationRate" DOUBLE PRECISION NOT NULL,
    "validTrackingRate" DOUBLE PRECISION NOT NULL,
    "defectRate" DOUBLE PRECISION NOT NULL,
    "returnRate" DOUBLE PRECISION NOT NULL,
    "newListingsPaused" BOOLEAN NOT NULL DEFAULT false,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB,
    "orderId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobLog" (
    "id" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "jobKey" TEXT,
    "status" "JobStatus" NOT NULL,
    "error" TEXT,
    "result" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "JobLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiCredential" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "authTag" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_code_key" ON "Supplier"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Product_supplierId_externalId_key" ON "Product"("supplierId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_productId_externalId_key" ON "ProductVariant"("productId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductImage_productId_position_key" ON "ProductImage"("productId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorListing_marketplace_externalId_key" ON "CompetitorListing"("marketplace", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorImage_listingId_position_key" ON "CompetitorImage"("listingId", "position");

-- CreateIndex
CREATE INDEX "ProductMatch_status_idx" ON "ProductMatch"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMatch_variantId_competitorListingId_key" ON "ProductMatch"("variantId", "competitorListingId");

-- CreateIndex
CREATE INDEX "DemandSnapshot_variantId_capturedAt_idx" ON "DemandSnapshot"("variantId", "capturedAt");

-- CreateIndex
CREATE INDEX "TrendSnapshot_keyword_capturedAt_idx" ON "TrendSnapshot"("keyword", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Holiday_code_key" ON "Holiday"("code");

-- CreateIndex
CREATE INDEX "Listing_status_idx" ON "Listing"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Listing_marketplace_sku_key" ON "Listing"("marketplace", "sku");

-- CreateIndex
CREATE INDEX "PriceHistory_listingId_createdAt_idx" ON "PriceHistory"("listingId", "createdAt");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_marketplace_externalId_key" ON "Order"("marketplace", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_orderId_externalLineId_key" ON "OrderItem"("orderId", "externalLineId");

-- CreateIndex
CREATE UNIQUE INDEX "SupplierOrder_idempotencyKey_key" ON "SupplierOrder"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "TrackingEvent_supplierOrderId_status_occurredAt_key" ON "TrackingEvent"("supplierOrderId", "status", "occurredAt");

-- CreateIndex
CREATE INDEX "AccountHealth_marketplace_capturedAt_idx" ON "AccountHealth"("marketplace", "capturedAt");

-- CreateIndex
CREATE INDEX "Alert_resolvedAt_idx" ON "Alert"("resolvedAt");

-- CreateIndex
CREATE INDEX "JobLog_queue_startedAt_idx" ON "JobLog"("queue", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_provider_key" ON "ApiCredential"("provider");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorImage" ADD CONSTRAINT "CompetitorImage_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "CompetitorListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMatch" ADD CONSTRAINT "ProductMatch_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductMatch" ADD CONSTRAINT "ProductMatch_competitorListingId_fkey" FOREIGN KEY ("competitorListingId") REFERENCES "CompetitorListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemandSnapshot" ADD CONSTRAINT "DemandSnapshot_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrendSnapshot" ADD CONSTRAINT "TrendSnapshot_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_holidayId_fkey" FOREIGN KEY ("holidayId") REFERENCES "Holiday"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceHistory" ADD CONSTRAINT "PriceHistory_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierOrder" ADD CONSTRAINT "SupplierOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackingEvent" ADD CONSTRAINT "TrackingEvent_supplierOrderId_fkey" FOREIGN KEY ("supplierOrderId") REFERENCES "SupplierOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
