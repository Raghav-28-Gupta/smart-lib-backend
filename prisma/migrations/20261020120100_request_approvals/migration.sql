-- Request approvals: borrow requests, and room bookings that wait for a
-- librarian. The enum values used here were added by the previous migration.

-- CreateEnum
CREATE TYPE "BorrowRequestStatus" AS ENUM ('pending', 'approved', 'declined', 'expired', 'cancelled');

-- AlterTable
ALTER TABLE "ResourceBooking" ADD COLUMN     "decidedAt" TIMESTAMPTZ(3),
ADD COLUMN     "decidedById" TEXT,
ADD COLUMN     "declineReason" TEXT,
ADD COLUMN     "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "BorrowRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bookId" TEXT NOT NULL,
    "bookCopyId" TEXT NOT NULL,
    "status" "BorrowRequestStatus" NOT NULL DEFAULT 'pending',
    "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "decidedAt" TIMESTAMPTZ(3),
    "decidedById" TEXT,
    "declineReason" TEXT,
    "loanId" TEXT,

    CONSTRAINT "BorrowRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BorrowRequest_loanId_key" ON "BorrowRequest"("loanId");

-- CreateIndex
CREATE INDEX "BorrowRequest_status_expiresAt_idx" ON "BorrowRequest"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "ResourceBooking_status_startTime_idx" ON "ResourceBooking"("status", "startTime");

-- AddForeignKey
ALTER TABLE "ResourceBooking" ADD CONSTRAINT "ResourceBooking_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BorrowRequest" ADD CONSTRAINT "BorrowRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BorrowRequest" ADD CONSTRAINT "BorrowRequest_bookId_fkey" FOREIGN KEY ("bookId") REFERENCES "Book"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BorrowRequest" ADD CONSTRAINT "BorrowRequest_bookCopyId_fkey" FOREIGN KEY ("bookCopyId") REFERENCES "BookCopy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BorrowRequest" ADD CONSTRAINT "BorrowRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BorrowRequest" ADD CONSTRAINT "BorrowRequest_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================================
-- Hand-written: Prisma's schema language can express neither of these.
-- ============================================================================

-- One pending request per student and title. Two quick taps would otherwise
-- hold two copies. A violation surfaces as SQLSTATE 23505.
CREATE UNIQUE INDEX "BorrowRequest_one_pending_per_title"
ON "BorrowRequest"("userId", "bookId") WHERE status = 'pending';

-- A pending room request holds its slot, so the exclusion constraint now
-- covers 'requested' too. Declined, expired and cancelled rows free it.
ALTER TABLE "ResourceBooking" DROP CONSTRAINT no_overlapping_bookings;

ALTER TABLE "ResourceBooking"
ADD CONSTRAINT no_overlapping_bookings
EXCLUDE USING gist (
  "resourceId" WITH =,
  tstzrange("startTime", "endTime") WITH &&
) WHERE (status IN ('requested', 'booked', 'checked_in'));
