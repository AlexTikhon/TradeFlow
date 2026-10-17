import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { REFERENCE } from './database.js';

/*
 * The data a test starts from, written straight into the E2E database, as the API integration
 * tests do with their fixtures: there is no API for organizations, users or trade strings.
 * Every test gets its own: fresh organizations, operators and a voyage, so tests never see each
 * other's notices or streams. Everything a test then does (signing in, issuing, acknowledging)
 * goes through the browser and the real API.
 */

export interface Party {
  email: string;
  fullName: string;
  organizationName: string;
}

export interface Scenario {
  voyage: { id: string; reference: string };
  /** An operator of the exporter, who sells under the voyage's only contract. */
  seller: Party;
  /** An operator of the final buyer, who buys under it. */
  buyer: Party;
  /** Another operator of the final buyer: the buyer's colleague, on a machine of their own. */
  buyerColleague: Party;
}

/**
 * Exporter → final buyer, one contract between them; one operator for the seller, two for the
 * buyer.
 */
export async function createScenario(pool: pg.Pool, passwordHash: string): Promise<Scenario> {
  const tag = randomBytes(4).toString('hex');
  const seller: Party = {
    email: `seller.${tag}@exporter.e2e.example`,
    fullName: `Sofia Seller ${tag}`,
    organizationName: `Exporter ${tag} S.A.`,
  };
  const buyer: Party = {
    email: `buyer.${tag}@buyer.e2e.example`,
    fullName: `Bruno Buyer ${tag}`,
    organizationName: `Final Buyer ${tag} GmbH`,
  };
  const buyerColleague: Party = {
    email: `colleague.${tag}@buyer.e2e.example`,
    fullName: `Carla Colleague ${tag}`,
    organizationName: buyer.organizationName,
  };
  const reference = `E2E-${tag.toUpperCase()}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const organization = async (name: string, countryCode: string) =>
      one<{ id: string }>(
        client,
        `INSERT INTO organizations (name, country_code, updated_at) VALUES ($1, $2, now())
         RETURNING id`,
        [name, countryCode],
      );
    const user = async (organizationId: string, party: Party) =>
      client.query(
        `INSERT INTO users (organization_id, email, full_name, role, password_hash, updated_at)
         VALUES ($1, $2, $3, 'OPERATOR', $4, now())`,
        [organizationId, party.email, party.fullName, passwordHash],
      );
    const sellerOrganization = await organization(seller.organizationName, 'BR');
    const buyerOrganization = await organization(buyer.organizationName, 'DE');
    await user(sellerOrganization.id, seller);
    await user(buyerOrganization.id, buyer);
    await user(buyerOrganization.id, buyerColleague);

    const voyage = await one<{ id: string }>(
      client,
      `INSERT INTO voyages (reference, status, vessel_id, commodity_id, quantity, load_port_id,
                            discharge_port_id, laycan_start, laycan_end, updated_at)
       SELECT $1, 'PLANNED', v.id, c.id, 60000, lp.id, dp.id,
              current_date + 10, current_date + 20, now()
       FROM vessels v, commodities c, ports lp, ports dp
       WHERE v.imo_number = $2 AND c.code = $3 AND lp.un_locode = $4 AND dp.un_locode = $5
       RETURNING id`,
      [
        reference,
        REFERENCE.imoNumber,
        REFERENCE.commodityCode,
        REFERENCE.loadPort,
        REFERENCE.dischargePort,
      ],
    );
    const participant = async (organizationId: string, role: string) =>
      one<{ id: string }>(
        client,
        `INSERT INTO voyage_participants (voyage_id, organization_id, role)
         VALUES ($1, $2, $3::participant_role) RETURNING id`,
        [voyage.id, organizationId, role],
      );
    const exporter = await participant(sellerOrganization.id, 'EXPORTER');
    const finalBuyer = await participant(buyerOrganization.id, 'FINAL_BUYER');
    await client.query(
      `INSERT INTO trade_contracts (voyage_id, position, seller_participant_id, buyer_participant_id)
       VALUES ($1, 1, $2, $3)`,
      [voyage.id, exporter.id, finalBuyer.id],
    );
    await client.query('COMMIT');
    return { voyage: { id: voyage.id, reference }, seller, buyer, buyerColleague };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function one<T>(client: pg.PoolClient, sql: string, values: unknown[]): Promise<T> {
  const { rows } = await client.query(sql, values);
  const [row] = rows as T[];
  if (row === undefined) throw new Error(`Expected one row from: ${sql}`);
  return row;
}
