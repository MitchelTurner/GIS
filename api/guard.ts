import { CanActivate, Controller, ExecutionContext, ForbiddenException, Get, Injectable } from '@nestjs/common';
import type { Request } from 'express';

// Uploads and AI requests must come from this site's own page, not another website.
@Injectable()
export class SameOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
    const origin = req.headers.origin;
    if (!origin) return true;
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {
      host = '';
    }
    if (host !== req.headers.host) throw new ForbiddenException('Requests must come from this site.');
    return true;
  }
}

@Controller('api/server')
export class ServerController {
  @Get()
  status() {
    return { database: true };
  }
}
