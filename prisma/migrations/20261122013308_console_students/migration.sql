-- AlterTable
ALTER TABLE "ReliabilityScoreLog" ADD COLUMN     "adjustedById" TEXT;

-- AddForeignKey
ALTER TABLE "ReliabilityScoreLog" ADD CONSTRAINT "ReliabilityScoreLog_adjustedById_fkey" FOREIGN KEY ("adjustedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
