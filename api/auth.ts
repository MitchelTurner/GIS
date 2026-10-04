import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Injectable,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { PrismaService } from './prisma.service.js';

export const COOKIE = 'kp_session';
const SESSION_DAYS = 30;
const PUBLIC_ROUTE = 'publicRoute';
const FAILURE_LIMIT = 8;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export const Public = () => SetMetadata(PUBLIC_ROUTE, true);

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function readCookie(header: string | undefined, name: string) {
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return '';
}

function cookieHeader(value: string, maxAgeSeconds: number) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

@Injectable()
export class AuthService {
  private failures = new Map<string, { count: number; since: number }>();

  constructor(private readonly prisma: PrismaService) {}

  configured() {
    return Boolean(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD_HASH);
  }

  private blocked(ip: string) {
    const entry = this.failures.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.since > FAILURE_WINDOW_MS) {
      this.failures.delete(ip);
      return false;
    }
    return entry.count >= FAILURE_LIMIT;
  }

  private fail(ip: string) {
    const entry = this.failures.get(ip);
    if (!entry || Date.now() - entry.since > FAILURE_WINDOW_MS) this.failures.set(ip, { count: 1, since: Date.now() });
    else entry.count += 1;
  }

  async login(email: string, password: string, ip: string) {
    if (!this.configured()) {
      throw new ServiceUnavailableException('Server sign-in needs ADMIN_EMAIL and ADMIN_PASSWORD_HASH.');
    }
    if (this.blocked(ip)) throw new HttpException('Too many tries. Wait 15 minutes and sign in again.', 429);
    const emailOk = String(email || '').trim().toLowerCase() === String(process.env.ADMIN_EMAIL).trim().toLowerCase();
    let passwordOk = false;
    try {
      passwordOk = await argon2.verify(String(process.env.ADMIN_PASSWORD_HASH), String(password || ''));
    } catch {
      passwordOk = false;
    }
    if (!emailOk || !passwordOk) {
      this.fail(ip);
      throw new UnauthorizedException('That email and password do not match.');
    }
    this.failures.delete(ip);
    const token = randomBytes(32).toString('base64url');
    await this.prisma.session.create({
      data: { id: hashToken(token), expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000) },
    });
    await this.prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return token;
  }

  async session(req: Request) {
    const token = readCookie(req.headers.cookie, COOKIE);
    if (!token) return null;
    const row = await this.prisma.session.findUnique({ where: { id: hashToken(token) } });
    if (!row || row.expiresAt < new Date()) return null;
    return row;
  }

  async logout(req: Request) {
    const token = readCookie(req.headers.cookie, COOKIE);
    if (token) await this.prisma.session.deleteMany({ where: { id: hashToken(token) } });
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin) {
        let host = '';
        try {
          host = new URL(origin).host;
        } catch {
          host = '';
        }
        if (host !== req.headers.host) throw new ForbiddenException('Requests must come from this site.');
      }
    }
    const open = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, [context.getHandler(), context.getClass()]);
    if (open) return true;
    if (!(await this.auth.session(req))) throw new UnauthorizedException('Sign in first.');
    return true;
  }
}

@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: { email?: string; password?: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = await this.auth.login(String(body?.email || ''), String(body?.password || ''), req.ip || '');
    res.setHeader('Set-Cookie', cookieHeader(token, SESSION_DAYS * 86400));
    return { email: process.env.ADMIN_EMAIL };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req);
    res.setHeader('Set-Cookie', cookieHeader('', 0));
    return { ok: true };
  }

  @Get('me')
  me() {
    return { email: process.env.ADMIN_EMAIL };
  }
}
