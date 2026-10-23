-- Enum values for request approvals. In a migration of their own because
-- PostgreSQL cannot use an enum value in the transaction that adds it, and the
-- next migration's exclusion constraint uses 'requested'.

-- AlterEnum
ALTER TYPE "CopyStatus" ADD VALUE 'requested';

-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE 'requested';
ALTER TYPE "BookingStatus" ADD VALUE 'declined';
ALTER TYPE "BookingStatus" ADD VALUE 'expired';
