import type { Request, Response, NextFunction } from 'express';
import { z, ZodError } from 'zod';

export function validate(schema: z.ZodType) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      res.locals.data = schema.parse({ body: req.body, headers: req.headers });
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        res.status(400).json({ error: 'INVALID_DATA', details: error.issues });
        return;
      }
      console.error(error);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  };
}
