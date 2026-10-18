import { Injectable } from '@nestjs/common';
import {
  ORGANIZATION_SEARCH_MAX_RESULTS,
  type OrganizationSearchQuery,
  type OrganizationSearchResponse,
} from '@tradeflow/contracts';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import type { Principal } from '../auth/principal.js';
import { requireOperator } from '../auth/user-permissions.js';

/** `%`, `_` and `\` match literally: the search text is a part of a name, never a pattern. */
const literal = (text: string) => text.replace(/[\\%_]/g, (character) => `\\${character}`);

/**
 * Finding organizations to name in a trade string (ADR 0016). Organizations are a curated set,
 * read here and nowhere edited. The select is the allowlist of what a search reveals.
 */
@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Organizations whose name contains `search`, ignoring case, by name: at most a short page,
   * and never the caller's own. Only operators may search, since only they can use the result.
   */
  async search(
    principal: Principal,
    { search }: OrganizationSearchQuery,
  ): Promise<OrganizationSearchResponse> {
    requireOperator(principal, 'search organizations');
    const items = await this.prisma.organization.findMany({
      where: {
        name: { contains: literal(search), mode: 'insensitive' },
        id: { not: principal.organizationId },
      },
      select: { id: true, name: true, countryCode: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: ORGANIZATION_SEARCH_MAX_RESULTS,
    });
    return { items };
  }
}
