import { Router } from 'express';
import type { z } from 'zod';
import { prisma } from '../config/prisma.ts';
import { Prisma } from '../generated/prisma/client.ts';
import { createUserSchema } from '../middlewares/schema/user.schema.ts';
import { validate } from '../middlewares/validate.middleware.ts';

const router = Router();

router.get('/', async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
  });

  return res.json(users);
});

router.post('/', validate(createUserSchema), async (_req, res) => {
  const { body } = res.locals.data as z.infer<typeof createUserSchema>;

  try {
    const user = await prisma.user.create({ data: body });
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
