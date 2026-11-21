-- AlterEnum
ALTER TYPE "FineReason" ADD VALUE 'lost';

-- AlterEnum
ALTER TYPE "FineStatus" ADD VALUE 'adjusted';

-- AlterTable
ALTER TABLE "Fine" ADD COLUMN     "adjustReason" TEXT,
ADD COLUMN     "adjustedAt" TIMESTAMP(3),
ADD COLUMN     "adjustedById" TEXT,
ADD COLUMN     "originalAmount" DOUBLE PRECISION,
ADD COLUMN     "paidAt" TIMESTAMP(3),
ADD COLUMN     "paidRecordedById" TEXT;

-- CreateIndex
CREATE INDEX "Fine_createdAt_idx" ON "Fine"("createdAt");

-- AddForeignKey
ALTER TABLE "Fine" ADD CONSTRAINT "Fine_adjustedById_fkey" FOREIGN KEY ("adjustedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fine" ADD CONSTRAINT "Fine_paidRecordedById_fkey" FOREIGN KEY ("paidRecordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
