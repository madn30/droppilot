-- AlterTable
ALTER TABLE "AccountHealth" ALTER COLUMN "lateShipmentRate" DROP NOT NULL,
ALTER COLUMN "cancellationRate" DROP NOT NULL,
ALTER COLUMN "validTrackingRate" DROP NOT NULL,
ALTER COLUMN "defectRate" DROP NOT NULL,
ALTER COLUMN "returnRate" DROP NOT NULL;
