import { prisma } from '../config/prisma.js';
import {
  LedgerType,
  Prisma,
  TransferStatus,
} from '../generated/prisma/client.js';
import { HttpError } from '../utils/index.js';

type LockUser = {
  id: string;
  balance: bigint;
};

export async function transferFunds(
  fromId: string,
  toId: string,
  amount: bigint,
  idempotencyKey: string,
) {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const transfer = await tx.transfer.create({
          data: {
            fromUserId: fromId,
            toUserId: toId,
            amount,
            idempotencyKey,
          },
        });

        const lockRows = await tx.$queryRaw<Array<LockUser>>`
          SELECT id, balance FROM "users" WHERE id IN (${fromId}, ${toId}) 
          ORDER BY id FOR NO KEY UPDATE
        `;

        const from = lockRows.find((row) => row.id === fromId)!;

        if (from.balance < amount) {
          throw new HttpError(422, 'INSUFFICIENT_BALANCE');
        }

        await tx.user.update({
          where: { id: fromId },
          data: { balance: { decrement: amount } },
        });

        await tx.user.update({
          where: { id: toId },
          data: { balance: { increment: amount } },
        });

        await tx.ledger.createMany({
          data: [
            {
              userId: fromId,
              amount: -amount,
              type: LedgerType.DEBIT,
              transferId: transfer.id,
            },
            {
              userId: toId,
              amount: amount,
              type: LedgerType.CREDIT,
              transferId: transfer.id,
            },
          ],
        });

        return tx.transfer.update({
          where: { id: transfer.id },
          data: { status: TransferStatus.COMPLETED },
        });
      },
      { timeout: 10_000 },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        const existing = await prisma.transfer.findUniqueOrThrow({
          where: { idempotencyKey },
        });

        if (
          existing.fromUserId !== fromId ||
          existing.toUserId !== toId ||
          existing.amount !== amount
        ) {
          throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED');
        }
        if (existing.status === TransferStatus.PENDING) {
          throw new HttpError(409, 'TRANSFER_IN_PROGRESS');
        }

        if (existing.status === TransferStatus.FAILED) {
          throw new HttpError(422, existing.failureReason ?? 'TRANSFER_FAILED');
        }

        return existing;
      } else if (error.code === 'P2003') {
        throw new HttpError(404, 'WALLET_NOT_FOUND');
      }
    }
    throw error;
  }
}
