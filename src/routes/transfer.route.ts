import { Router } from 'express';
import type { z } from 'zod';
import { transferFunds } from '../services/transaction.service.ts';
import { HttpError } from '../utils/index.ts';
import { transferSchema } from '../middlewares/schema/transfer.schema.ts';
import { validate } from '../middlewares/validate.middleware.ts';

const router = Router();

router.post('/', validate(transferSchema), async (_req, res) => {
  const { headers, body } = res.locals.data as z.infer<typeof transferSchema>;

  try {
    const transfer = await transferFunds(
      body.fromId,
      body.toId,
      body.amount,
      headers['idempotency-key'],
    );

    res.status(201).json(transfer);
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
  }
});

export default router;
