import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import { Public } from '../modules/auth/auth.decorators.js';

/** Readiness probe for Docker, CI and load balancers: the process is up and the DB answers. */
@ApiExcludeController()
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException('Database is unreachable.');
    }
    return { status: 'ok' };
  }
}
