import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { createHandler } from '../server.mjs';
import { AiController } from './ai.js';
import { AiToolService } from './ai-tools.js';
import { SameOriginGuard, ServerController } from './guard.js';
import { ImportController, ParcelController, ParcelService } from './parcels.js';
import { PrismaService } from './prisma.service.js';

@Module({
  controllers: [ServerController, ImportController, ParcelController, AiController],
  providers: [PrismaService, ParcelService, AiToolService, { provide: APP_GUARD, useClass: SameOriginGuard }],
})
class AppModule {}

export async function createServer() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn'] });
  app.set('trust proxy', 1);
  app.useBodyParser('json', { limit: '1mb' });
  const site = await createHandler();
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      next();
      return;
    }
    site(req, res);
  });
  app.enableShutdownHooks();
  await app.init();
  return app;
}

export async function bootstrap(port = Number(process.env.PORT) || 3000) {
  const app = await createServer();
  await app.listen(port, '0.0.0.0');
  console.log(`Parcel site with the database listening on ${port}`);
  return app;
}
