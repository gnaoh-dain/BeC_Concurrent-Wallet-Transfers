export class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function parseAmount(raw: unknown): bigint {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
    throw new HttpError(400, 'INVALID_AMOUNT');
  }
  return BigInt(raw);
}
