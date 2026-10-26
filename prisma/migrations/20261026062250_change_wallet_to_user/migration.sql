/*
  Warnings:

  - You are about to drop the column `walletId` on the `ledgers` table. All the data in the column will be lost.
  - You are about to drop the `wallets` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `userId` to the `ledgers` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "ledgers" DROP CONSTRAINT "ledgers_walletId_fkey";

-- DropForeignKey
ALTER TABLE "wallets" DROP CONSTRAINT "wallets_userId_fkey";

-- AlterTable
ALTER TABLE "ledgers" DROP COLUMN "walletId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "balance" BIGINT NOT NULL DEFAULT 0;

-- DropTable
DROP TABLE "wallets";

-- AddForeignKey
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
