import 'dotenv/config';
import { app } from './app.js';
import { prisma } from './config/prisma.js';

const port = Number(process.env.PORT ?? 3000);

async function bootstrap() {
  try {
    await prisma.$connect();

    app.listen(port, () => {
      console.log(`Server running on port ${port}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

bootstrap();
