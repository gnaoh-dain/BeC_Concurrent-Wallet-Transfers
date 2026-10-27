import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

function checkBalance(data: any): boolean {
  const balance = data?.balance ?? 0n;
  return balance < 0n;
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

export const prisma = new PrismaClient({ adapter }).$extends({
  query: {
    user: {
      async create({ args, query }) {
        checkBalance(args.data);
        return query(args);
      },
      async update({ args, query }) {
        checkBalance(args.data);
        return query(args);
      },
      async updateMany({ args, query }) {
        checkBalance(args.data);
        return query(args);
      },
      async upsert({ args, query }) {
        checkBalance(args.create);
        checkBalance(args.update);
        return query(args);
      },
    },
  },
});
