-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "buyerUsername" TEXT;

-- CreateIndex
CREATE INDEX "Order_marketplace_buyerUsername_idx" ON "Order"("marketplace", "buyerUsername");
