ALTER TABLE "Resource" ADD COLUMN "seatRow" INTEGER, ADD COLUMN "seatColumn" INTEGER;
ALTER TABLE "Resource" ADD CONSTRAINT "Resource_position_pair" CHECK (("seatRow" IS NULL) = ("seatColumn" IS NULL));
CREATE UNIQUE INDEX "Resource_seat_position_unique" ON "Resource" ("location", "seatRow", "seatColumn") WHERE "seatRow" IS NOT NULL;
CREATE TABLE "SeatZone" ("name" TEXT NOT NULL, "frontLabel" TEXT, CONSTRAINT "SeatZone_pkey" PRIMARY KEY ("name"));
