import {
  CommodityListResponseSchema,
  PortListResponseSchema,
  type ProblemDetails,
  ProblemDetailsSchema,
  VesselListResponseSchema,
} from '@tradeflow/contracts';
import type { Party } from '../support/scenario.js';

/*
 * The portfolio run's write budget (ADR 0021) as a client meets it: one signed-in account
 * talking to the run's web origin (the web server's same-origin /api proxy, as a browser does),
 * creating voyages, the one business command that needs nothing but reference data. Used by the
 * portfolio verification and by the reset rehearsal; the session cookie never leaves this module.
 */

const REQUEST_TIMEOUT_MS = 30_000;

/** What a command answered: its status and, for a refusal, its Problem Details. */
export interface CommandAnswer {
  status: number;
  problem: ProblemDetails | undefined;
  retryAfter: string | null;
}

export class DemoClient {
  private cookie: string | undefined;
  private voyageBody: unknown;

  private constructor(
    private readonly webUrl: string,
    readonly party: Party,
  ) {}

  /** Signs `party` in with their published demo password. */
  static async signIn(webUrl: string, party: Party): Promise<DemoClient> {
    const client = new DemoClient(webUrl, party);
    const response = await client.request('POST', '/api/auth/sign-in', {
      email: party.email,
      password: party.password,
    });
    if (response.status !== 200) {
      throw new Error(`Signing in ${party.fullName} answered ${response.status}`);
    }
    client.cookie = response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0]?.trim() ?? '')
      .find((pair) => /^(__Host-)?tradeflow_session=./.test(pair));
    if (client.cookie === undefined) throw new Error(`Signing in ${party.fullName} set no cookie`);
    return client;
  }

  /** GETs `path` and answers its status. */
  async read(path: string): Promise<number> {
    const response = await this.request('GET', path);
    await response.arrayBuffer();
    return response.status;
  }

  /** GETs `path`, which must answer 200, and answers its JSON body. */
  async readJson(path: string): Promise<unknown> {
    const response = await this.request('GET', path);
    if (response.status !== 200) throw new Error(`GET ${path} answered ${response.status}`);
    return response.json();
  }

  /** Creates a voyage from the seeded reference data: one business command. */
  async createVoyage(): Promise<CommandAnswer> {
    this.voyageBody ??= await this.newVoyageBody();
    const response = await this.request('POST', '/api/voyages', this.voyageBody);
    const text = await response.text();
    return {
      status: response.status,
      problem: response.status === 201 ? undefined : ProblemDetailsSchema.parse(JSON.parse(text)),
      retryAfter: response.headers.get('retry-after'),
    };
  }

  async signOut(): Promise<number> {
    const response = await this.request('POST', '/api/auth/sign-out');
    await response.arrayBuffer();
    this.cookie = undefined;
    return response.status;
  }

  private async newVoyageBody(): Promise<unknown> {
    const json = async (path: string) => {
      const response = await this.request('GET', path);
      if (response.status !== 200) throw new Error(`GET ${path} answered ${response.status}`);
      return (await response.json()) as unknown;
    };
    const vessels = VesselListResponseSchema.parse(await json('/api/vessels')).items;
    const commodities = CommodityListResponseSchema.parse(await json('/api/commodities')).items;
    const ports = PortListResponseSchema.parse(await json('/api/ports')).items;
    const [vessel, commodity, loadPort, dischargePort] = [
      vessels[0],
      commodities[0],
      ports[0],
      ports[1],
    ];
    if (!vessel || !commodity || !loadPort || !dischargePort) {
      throw new Error('The seeded reference data is missing');
    }
    return {
      vesselId: vessel.id,
      commodityId: commodity.id,
      quantity: { amount: '1000', unit: 'MT' },
      loadPortId: loadPort.id,
      dischargePortId: dischargePort.id,
      laycan: { start: '2027-03-01', end: '2027-03-10' },
    };
  }

  private request(method: string, path: string, json?: unknown): Promise<Response> {
    return fetch(new URL(path, this.webUrl), {
      method,
      headers: {
        accept: 'application/json',
        ...(json !== undefined && { 'content-type': 'application/json' }),
        ...(this.cookie !== undefined && { cookie: this.cookie }),
      },
      ...(json !== undefined && { body: JSON.stringify(json) }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }
}

/** How a budget was used up: the commands admitted, then the first refusal. */
export interface UsedUpBudget {
  admitted: number;
  refusal: CommandAnswer;
}

/**
 * Creates voyages until the API refuses one, and answers how many it admitted first. Fails on
 * any other answer, or if more than `atMost` are admitted (the budget is not bounding anything).
 */
export async function useUpWriteBudget(client: DemoClient, atMost: number): Promise<UsedUpBudget> {
  for (let admitted = 0; admitted <= atMost; admitted += 1) {
    const answer = await client.createVoyage();
    if (answer.status === 429) return { admitted, refusal: answer };
    if (answer.status !== 201) {
      throw new Error(
        `Creating a voyage answered ${answer.status}: ${answer.problem?.detail ?? 'no detail'}`,
      );
    }
  }
  throw new Error(`More than ${atMost} commands were admitted: the write budget is not enforced`);
}
