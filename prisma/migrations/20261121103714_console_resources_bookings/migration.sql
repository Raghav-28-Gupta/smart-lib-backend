-- CreateEnum
CREATE TYPE "ResourceStatus" AS ENUM ('available', 'offline');

-- AlterTable
ALTER TABLE "Resource" ADD COLUMN     "status" "ResourceStatus" NOT NULL DEFAULT 'available',
ADD COLUMN     "statusNote" TEXT;

-- AlterTable
ALTER TABLE "ResourceBooking" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMPTZ(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "movedAt" TIMESTAMPTZ(3),
ADD COLUMN     "movedFromName" TEXT;

-- CreateIndex
CREATE INDEX "ResourceBooking_startTime_idx" ON "ResourceBooking"("startTime");

-- AddForeignKey
ALTER TABLE "ResourceBooking" ADD CONSTRAINT "ResourceBooking_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
