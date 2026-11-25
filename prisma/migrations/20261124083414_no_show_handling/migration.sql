-- CreateEnum
CREATE TYPE "NoShowDisputeStatus" AS ENUM ('open', 'overturned', 'upheld');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NoticeKind" ADD VALUE 'booking_reminder';
ALTER TYPE "NoticeKind" ADD VALUE 'no_show';
ALTER TYPE "NoticeKind" ADD VALUE 'no_show_outcome';

-- AlterTable
ALTER TABLE "NoShowEvent" ADD COLUMN     "reliabilityDelta" DOUBLE PRECISION,
ALTER COLUMN "predictedProbability" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Notice" ADD COLUMN     "bookingId" TEXT;

-- AlterTable
ALTER TABLE "ResourceBooking" ADD COLUMN     "reminderSentAt" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "NoShowDispute" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "NoShowDisputeStatus" NOT NULL DEFAULT 'open',
    "resolutionNote" TEXT,
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "NoShowDispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NoShowDispute_bookingId_key" ON "NoShowDispute"("bookingId");

-- CreateIndex
CREATE INDEX "NoShowDispute_status_createdAt_idx" ON "NoShowDispute"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "NoShowDispute" ADD CONSTRAINT "NoShowDispute_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "ResourceBooking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoShowDispute" ADD CONSTRAINT "NoShowDispute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoShowDispute" ADD CONSTRAINT "NoShowDispute_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notice" ADD CONSTRAINT "Notice_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "ResourceBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: until now a booking nobody attended only LOOKED released once its grace period passed
-- (every screen computes that from the times) and nothing wrote it. Persist exactly that for every
-- old row, so the no-show sweep never finds a past booking it could penalize. Nobody was told they
-- could be, so no penalty, no notice, no email: plain released, the state every screen already shows.
-- This is the last statement, and it only uses the existing 'released' value (a value added above
-- cannot be used in the migration that adds it).
UPDATE "ResourceBooking" SET status = 'released' WHERE status = 'booked' AND "startTime" + make_interval(mins => "gracePeriodMinutes") < now();
