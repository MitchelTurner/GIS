import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { aiStatus, explainComps } from '../lib/comps-ai.js';

@Controller('api')
export class AiController {
  @Get('ai')
  status() {
    return aiStatus();
  }

  @Post('explain')
  @HttpCode(200)
  explain(@Body() body: { subject?: object; comps?: unknown[]; question?: string }) {
    return explainComps(body?.subject || {}, Array.isArray(body?.comps) ? body.comps : [], {
      question: body?.question,
    });
  }
}
