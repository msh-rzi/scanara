-- AlterTable
ALTER TABLE "WatchedToken" ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "Scan_userId_idx" ON "Scan"("userId");

-- CreateIndex
CREATE INDEX "Scan_createdAt_idx" ON "Scan"("createdAt");

-- CreateIndex
CREATE INDEX "Scan_mintAddress_idx" ON "Scan"("mintAddress");

-- CreateIndex
CREATE INDEX "User_telegramId_idx" ON "User"("telegramId");

-- CreateIndex
CREATE INDEX "WatchedToken_userId_idx" ON "WatchedToken"("userId");
