import z from 'zod';

export const createUserSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(255),
    email: z.string().trim().toLowerCase().pipe(z.email()),
  }),
});
