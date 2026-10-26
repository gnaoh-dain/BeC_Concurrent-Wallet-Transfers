/*
  Warnings:

  - You are about to drop the column `updatedAt` on the `ledgers` table. All the data in the column will be lost.
  - You are about to drop the column `fromWalletId` on the `transfers` table. All the data in the column will be lost.
  - You are about to drop the column `toWalletId` on the `transfers` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[transferId,type]` on the table `ledgers` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[idempotencyKey]` on the table `transfers` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `transferId` to the `ledgers` table without a default value. This is not possible if the table is not empty.
  - Added the required column `fromUserId` to the `transfers` table without a default value. This is not possible if the table is not empty.
  - Added the required column `idempotencyKey` to the `transfers` table without a default value. This is not possible if the table is not empty.
  - Added the required column `toUserId` to the `transfers` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ledgers" DROP COLUMN "updatedAt",
ADD COLUMN     "transferId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "transfers" DROP COLUMN "fromWalletId",
DROP COLUMN "toWalletId",
ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "fromUserId" TEXT NOT NULL,
ADD COLUMN     "idempotencyKey" TEXT NOT NULL,
ADD COLUMN     "toUserId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "ledgers_userId_createdAt_idx" ON "ledgers"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ledgers_transferId_type_key" ON "ledgers"("transferId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "transfers_idempotencyKey_key" ON "transfers"("idempotencyKey");

-- CreateIndex
CREATE INDEX "transfers_fromUserId_createdAt_idx" ON "transfers"("fromUserId", "createdAt");

-- CreateIndex
CREATE INDEX "transfers_toUserId_createdAt_idx" ON "transfers"("toUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transfers" ADD CONSTRAINT "transfers_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
