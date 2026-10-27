import { Router } from 'express';
import { transferFunds } from '../services/transaction.service.js';
import { HttpError, parseAmount } from '../utils/index.js';

const router = Router();

router.post('/', async (req, res) => {
  const idempotencyKey = req.header('idempotency-key');
  const { fromId, toId, amount } = req.body ?? {};

  try {
    if (!idempotencyKey) {
      throw new HttpError(400, 'MISSING_IDEMPOTENCY_KEY');
    }
    if (
      typeof fromId !== 'string' ||
      typeof toId !== 'string' ||
      !fromId ||
      !toId
    ) {
      throw new HttpError(400, 'INVALID_WALLET_ID');
    }
    if (fromId === toId) {
      throw new HttpError(400, 'SAME_WALLET');
    }

    const parsedAmount = parseAmount(amount);
    if (parsedAmount <= 0n) {
      throw new HttpError(400, 'INVALID_AMOUNT');
    }

    const transfer = await transferFunds(
      fromId,
      toId,
      parsedAmount,
      idempotencyKey,
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
