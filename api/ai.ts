import { BadRequestException, Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { aiStatus, explainComps } from '../lib/comps-ai.js';
import { AiToolService } from './ai-tools.js';

@Controller('api')
export class AiController {
  constructor(private readonly tools: AiToolService) {}

  @Get('ai')
  status() {
    return { ...aiStatus(), database: true };
  }

  @Post('explain')
  @HttpCode(200)
  explain(@Body() body: { subject?: object; comps?: unknown[]; question?: string }) {
    return explainComps(body?.subject || {}, Array.isArray(body?.comps) ? body.comps : [], {
      question: body?.question,
      tools: this.toolbox(),
    });
  }

  @Post('ask')
  @HttpCode(200)
  ask(@Body() body: { question?: string; parcel?: string }) {
    const question = String(body?.question || '').trim();
    if (!question) throw new BadRequestException('Type a question first.');
    return explainComps({}, [], { question, openParcel: body?.parcel, tools: this.toolbox() });
  }

  private toolbox() {
    return { definitions: this.tools.definitions(), run: (name: string, input: Record<string, unknown>) => this.tools.run(name, input) };
  }
}
