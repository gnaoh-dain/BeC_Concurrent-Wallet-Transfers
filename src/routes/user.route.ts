import { Router } from 'express';
import { prisma } from '../config/prisma.js';
import { parseAmount } from '../utils/index.js';
import { Prisma } from '../generated/prisma/client.js';

const router = Router();

router.get('/', async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: {
      createdAt: 'desc',
    },
  });

  res.json(users);
});

router.post('/', async (req, res) => {
  const { name, email } = req.body;

  if (
    typeof name !== 'string' ||
    typeof email !== 'string' ||
    !name.trim() ||
    !email.trim()
  ) {
    return res.status(400).json({ message: 'Invalid name or email' });
  }

  try {
    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: email.trim().toLowerCase(),
      },
    });
    return res.status(201).json(user);
  } catch (error) {
    console.error(error);
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return res.status(409).json({ message: 'Email already exists' });
    }
    return res.status(500).json({ message: 'Internal server error' });
  }
});

export default router;
