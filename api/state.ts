import { BadRequestException, Body, Controller, Get, Param, Put } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

export const SHARED_KEYS = ['outreach', 'links', 'buybox', 'searches', 'changes', 'edits'];

@Controller('api/state')
export class StateController {
  constructor(private readonly prisma: PrismaService) {}

  // importId lets a page notice that another device imported a newer file.
  @Get()
  async all() {
    const [rows, last] = await Promise.all([
      this.prisma.sharedState.findMany(),
      this.prisma.import.findFirst({ orderBy: { id: 'desc' }, select: { id: true } }),
    ]);
    return {
      importId: last?.id ?? null,
      values: Object.fromEntries(rows.map((row) => [row.key, row.value])),
    };
  }

  @Put(':key')
  async save(@Param('key') key: string, @Body() body: { value?: unknown }) {
    if (!SHARED_KEYS.includes(key)) throw new BadRequestException(`The server keeps ${SHARED_KEYS.join(', ')}.`);
    if (!body || !('value' in body)) throw new BadRequestException('Send {"value": …}.');
    const value = (body.value ?? null) as never;
    const row = await this.prisma.sharedState.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
    return { key, updatedAt: row.updatedAt.toISOString() };
  }
}
