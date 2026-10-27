import z from 'zod';

export const transferSchema = z.object({
  headers: z.object({
    'idempotency-key': z.string().min(1).max(255),
  }),
  body: z
    .object({
      fromId: z.string().min(1),
      toId: z.string().min(1),
      amount: z
        .string()
        .regex(/^[1-9]\d*$/)
        .transform(BigInt),
    })
    .refine((b) => b.fromId !== b.toId, { message: 'SAME_WALLET' }),
});
