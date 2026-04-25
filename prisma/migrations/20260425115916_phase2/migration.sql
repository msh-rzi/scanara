-- AlterTable
ALTER TABLE "User" ADD COLUMN     "premiumUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WatchedToken" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "mintAddress" TEXT NOT NULL,
    "lastScore" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WatchedToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WatchedToken_userId_mintAddress_key" ON "WatchedToken"("userId", "mintAddress");

-- AddForeignKey
ALTER TABLE "WatchedToken" ADD CONSTRAINT "WatchedToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
