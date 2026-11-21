-- AlterEnum
ALTER TYPE "LoanStatus" ADD VALUE 'lost';

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "lostAt" TIMESTAMP(3);

-- Barcodes: SL-00001 and up, handed out by the database so every way of adding
-- a copy gets one. Prisma cannot express the sequence or the function, so they
-- are written by hand; the column, default and index below match what Prisma
-- generates for `barcode String @unique @default(dbgenerated("next_copy_barcode()"))`.
CREATE SEQUENCE "BookCopy_barcode_seq";

CREATE FUNCTION next_copy_barcode() RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  n bigint := nextval('"BookCopy_barcode_seq"');
BEGIN
  -- Five digits, widening instead of wrapping once past SL-99999.
  IF n < 100000 THEN
    RETURN 'SL-' || lpad(n::text, 5, '0');
  END IF;
  RETURN 'SL-' || n::text;
END;
$$;

-- AlterTable: nullable first, so the rows that exist can be numbered.
ALTER TABLE "BookCopy" ADD COLUMN     "barcode" TEXT;

-- Number every existing copy by book title, then copy id. row_number() fixes
-- the order; calling nextval inside an UPDATE ... FROM would not, because the
-- order rows are visited in is not guaranteed. (Same format as the function.)
WITH ordered AS (
  SELECT c."id", row_number() OVER (ORDER BY b."title", c."id") AS n
  FROM "BookCopy" c
  JOIN "Book" b ON b."id" = c."bookId"
)
UPDATE "BookCopy" AS c
SET "barcode" = CASE
  WHEN ordered.n < 100000 THEN 'SL-' || lpad(ordered.n::text, 5, '0')
  ELSE 'SL-' || ordered.n::text
END
FROM ordered
WHERE ordered."id" = c."id";

-- The next new copy continues after the highest number handed out. With no
-- copies there is nothing to continue from (and setval cannot take 0), so the
-- sequence stays at its start and the first copy gets SL-00001.
SELECT setval('"BookCopy_barcode_seq"', max(substr("barcode", 4)::bigint))
FROM "BookCopy"
HAVING count(*) > 0;

-- Every copy has a barcode now: require it, hand out the next one by default.
ALTER TABLE "BookCopy"
  ALTER COLUMN "barcode" SET NOT NULL,
  ALTER COLUMN "barcode" SET DEFAULT next_copy_barcode();

-- CreateIndex
CREATE UNIQUE INDEX "BookCopy_barcode_key" ON "BookCopy"("barcode");

-- Tie the sequence to the column, so TRUNCATE ... RESTART IDENTITY (the tests'
-- resetDb) starts the numbering again, and dropping the column drops the sequence.
ALTER SEQUENCE "BookCopy_barcode_seq" OWNED BY "BookCopy"."barcode";
