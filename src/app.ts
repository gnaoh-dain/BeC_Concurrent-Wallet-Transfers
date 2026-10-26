import express from 'express';
import userRouter from './routes/user.route.js';
import transferRouter from './routes/transfer.route.js';

export const app = express();

app.set('json replacer', (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value,
);

app.use(express.json());
app.use('/users', userRouter);
app.use('/transfers', transferRouter);

app.get('/health', async (_req, res) => {
  res.json({ status: 'ok' });
});
