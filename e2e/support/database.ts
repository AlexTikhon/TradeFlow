import pg from 'pg';

/*
 * The E2E database: a database of its own on the development Postgres server, dropped and
 * recreated by every run. Only a database whose name ends in `_e2e` is ever touched, so neither
 * the development database (`tradeflow`) nor the integration tests' (`tradeflow_test`) can be.
 */

const E2E_DATABASE_NAME = /^[a-z][a-z0-9_]*_e2e$/;

/** The database's name, once it is known to be an E2E database. Throws otherwise. */
export function e2eDatabaseName(databaseUrl: string): string {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (!E2E_DATABASE_NAME.test(name)) {
    throw new Error(
      `Refusing to use database "${name}" for E2E tests: its name must end in "_e2e", ` +
        'because every run drops and recreates it.',
    );
  }
  return name;
}

/** Runs `work` connected to the server's maintenance database, to create or drop the E2E one. */
async function withMaintenanceConnection(
  databaseUrl: string,
  work: (client: pg.Client, name: string) => Promise<void>,
): Promise<void> {
  const name = e2eDatabaseName(databaseUrl);
  const maintenance = new URL(databaseUrl);
  maintenance.pathname = '/postgres';
  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    await work(client, name);
  } finally {
    await client.end();
  }
}

/** Drops whatever an earlier run left behind and creates the database empty. */
export async function recreateDatabase(databaseUrl: string): Promise<void> {
  await withMaintenanceConnection(databaseUrl, async (client, name) => {
    // The name was checked against E2E_DATABASE_NAME, so quoting it is enough.
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
  });
}

export async function dropDatabase(databaseUrl: string): Promise<void> {
  await withMaintenanceConnection(databaseUrl, async (client, name) => {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  });
}

/** Codes of the reference data every scenario's voyage uses. */
export const REFERENCE = {
  imoNumber: '9341237',
  commodityCode: 'SOYBEANS',
  loadPort: 'BRSSZ',
  dischargePort: 'NLRTM',
} as const;

/** Reference data (vessel, commodity, ports) shared by every scenario of the run. */
export async function insertReferenceData(databaseUrl: string): Promise<void> {
  e2eDatabaseName(databaseUrl);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO vessels (name, imo_number, updated_at) VALUES ('MV E2E Horizon', $1, now())`,
      [REFERENCE.imoNumber],
    );
    await client.query(`INSERT INTO commodities (code, name) VALUES ($1, 'Soybeans')`, [
      REFERENCE.commodityCode,
    ]);
    await client.query(
      `INSERT INTO ports (un_locode, name, country_code)
       VALUES ($1, 'Santos', 'BR'), ($2, 'Rotterdam', 'NL')`,
      [REFERENCE.loadPort, REFERENCE.dischargePort],
    );
  } finally {
    await client.end();
  }
}
