import { Injectable, OnModuleDestroy } from '@nestjs/common';
import prismaPkg from '@prisma/client';

const { PrismaClient } = prismaPkg;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
