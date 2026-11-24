-- CreateEnum
CREATE TYPE "IssueCategory" AS ENUM ('damaged', 'missing_pages', 'not_working', 'dirty', 'other');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('open', 'confirmed', 'dismissed');

-- CreateTable
CREATE TABLE "IssueReport" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bookCopyId" TEXT,
    "resourceId" TEXT,
    "category" "IssueCategory" NOT NULL,
    "note" TEXT,
    "status" "ReportStatus" NOT NULL DEFAULT 'open',
    "resolutionNote" TEXT,
    "resolvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "IssueReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IssueReport_status_createdAt_idx" ON "IssueReport"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "IssueReport" ADD CONSTRAINT "IssueReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueReport" ADD CONSTRAINT "IssueReport_bookCopyId_fkey" FOREIGN KEY ("bookCopyId") REFERENCES "BookCopy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueReport" ADD CONSTRAINT "IssueReport_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "Resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueReport" ADD CONSTRAINT "IssueReport_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A report is about exactly one thing: a book copy or a seat/room. Prisma cannot express a CHECK.
ALTER TABLE "IssueReport"
  ADD CONSTRAINT "IssueReport_exactly_one_target"
  CHECK (num_nonnulls("bookCopyId", "resourceId") = 1);

-- A student has at most one open report per copy and one per resource. Prisma cannot express
-- a partial unique index; a NULL target never collides, so each index only sees its own kind.
CREATE UNIQUE INDEX "IssueReport_one_open_per_copy"
  ON "IssueReport"("userId", "bookCopyId") WHERE status = 'open';

CREATE UNIQUE INDEX "IssueReport_one_open_per_resource"
  ON "IssueReport"("userId", "resourceId") WHERE status = 'open';
