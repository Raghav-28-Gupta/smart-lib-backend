-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('open', 'waived', 'adjusted', 'upheld');

-- AlterTable
ALTER TABLE "Fine" ADD COLUMN     "disputedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "FineDispute" (
    "id" TEXT NOT NULL,
    "fineId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'open',
    "resolutionNote" TEXT,
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "FineDispute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FineDispute_fineId_key" ON "FineDispute"("fineId");

-- CreateIndex
CREATE INDEX "FineDispute_status_createdAt_idx" ON "FineDispute"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "FineDispute" ADD CONSTRAINT "FineDispute_fineId_fkey" FOREIGN KEY ("fineId") REFERENCES "Fine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FineDispute" ADD CONSTRAINT "FineDispute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FineDispute" ADD CONSTRAINT "FineDispute_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
