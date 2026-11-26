-- CreateIndex
CREATE UNIQUE INDEX "RecommendationCache_userId_bookId_key" ON "RecommendationCache"("userId", "bookId");
