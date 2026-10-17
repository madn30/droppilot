-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "groupKey" TEXT;

-- CreateIndex
CREATE INDEX "Listing_marketplace_groupKey_idx" ON "Listing"("marketplace", "groupKey");
