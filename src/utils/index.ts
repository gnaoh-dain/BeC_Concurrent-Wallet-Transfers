import { Prisma } from '../generated/prisma/client.ts';

export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const CHECK_CONSTRAINT_ERRORS: Record<
  string,
  [status: number, message: string]
> = {
  transfers_amount_positive: [400, 'INVALID_AMOUNT'],
  transfers_no_self_transfer: [400, 'SAME_WALLET'],
  users_balance_non_negative: [422, 'INSUFFICIENT_BALANCE'],
};

export function checkConstraintError(error: unknown): HttpError | undefined {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return;
  const cause = (
    error.meta?.driverAdapterError as
      | { cause?: { code?: string; originalMessage?: string } }
      | undefined
  )?.cause;
  if (cause?.code !== '23514') return;

  const name = cause.originalMessage?.match(/check constraint "([^"]+)"/)?.[1];
  const mapped = name ? CHECK_CONSTRAINT_ERRORS[name] : undefined;
  return mapped && new HttpError(...mapped);
}

export function parseAmount(raw: unknown): bigint {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
    throw new HttpError(400, 'INVALID_AMOUNT');
  }
  return BigInt(raw);
}
