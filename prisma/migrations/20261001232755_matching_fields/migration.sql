-- AlterTable
ALTER TABLE "CompetitorImage" ADD COLUMN     "localPath" TEXT;

-- AlterTable
ALTER TABLE "CompetitorListing" ADD COLUMN     "description" TEXT;

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "specs" JSONB;
