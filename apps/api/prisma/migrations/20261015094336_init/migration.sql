-- CreateEnum
CREATE TYPE "voyage_status" AS ENUM ('PLANNED', 'LOADING', 'IN_TRANSIT', 'DISCHARGING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "quantity_unit" AS ENUM ('MT');

-- CreateEnum
CREATE TYPE "participant_role" AS ENUM ('EXPORTER', 'TRADER', 'FINAL_BUYER', 'SURVEYOR', 'SHIPPING_AGENT');

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vessels" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "imo_number" CHAR(7) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vessels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commodities" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "commodities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ports" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "un_locode" CHAR(5) NOT NULL,
    "name" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,

    CONSTRAINT "ports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voyages" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "reference" TEXT NOT NULL,
    "status" "voyage_status" NOT NULL DEFAULT 'PLANNED',
    "vessel_id" UUID NOT NULL,
    "commodity_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "quantity_unit" "quantity_unit" NOT NULL DEFAULT 'MT',
    "load_port_id" UUID NOT NULL,
    "discharge_port_id" UUID NOT NULL,
    "laycan_start" DATE NOT NULL,
    "laycan_end" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "voyages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voyage_participants" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "voyage_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "role" "participant_role" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voyage_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_organization_id_idx" ON "users"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "vessels_imo_number_key" ON "vessels"("imo_number");

-- CreateIndex
CREATE UNIQUE INDEX "commodities_code_key" ON "commodities"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ports_un_locode_key" ON "ports"("un_locode");

-- CreateIndex
CREATE UNIQUE INDEX "voyages_reference_key" ON "voyages"("reference");

-- CreateIndex
CREATE INDEX "voyages_status_laycan_start_idx" ON "voyages"("status", "laycan_start");

-- CreateIndex
CREATE INDEX "voyages_vessel_id_idx" ON "voyages"("vessel_id");

-- CreateIndex
CREATE INDEX "voyage_participants_organization_id_voyage_id_idx" ON "voyage_participants"("organization_id", "voyage_id");

-- CreateIndex
CREATE UNIQUE INDEX "voyage_participants_voyage_id_organization_id_role_key" ON "voyage_participants"("voyage_id", "organization_id", "role");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyages" ADD CONSTRAINT "voyages_vessel_id_fkey" FOREIGN KEY ("vessel_id") REFERENCES "vessels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyages" ADD CONSTRAINT "voyages_commodity_id_fkey" FOREIGN KEY ("commodity_id") REFERENCES "commodities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyages" ADD CONSTRAINT "voyages_load_port_id_fkey" FOREIGN KEY ("load_port_id") REFERENCES "ports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyages" ADD CONSTRAINT "voyages_discharge_port_id_fkey" FOREIGN KEY ("discharge_port_id") REFERENCES "ports"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyage_participants" ADD CONSTRAINT "voyage_participants_voyage_id_fkey" FOREIGN KEY ("voyage_id") REFERENCES "voyages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "voyage_participants" ADD CONSTRAINT "voyage_participants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants (Prisma schema cannot express CHECK constraints).
-- The database is the last line of defence for rules every writer must obey.
-- ---------------------------------------------------------------------------

ALTER TABLE "organizations" ADD CONSTRAINT "organizations_country_code_format" CHECK ("country_code" ~ '^[A-Z]{2}$');

ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("email" = lower("email"));

ALTER TABLE "vessels" ADD CONSTRAINT "vessels_imo_number_format" CHECK ("imo_number" ~ '^[0-9]{7}$');

ALTER TABLE "ports" ADD CONSTRAINT "ports_un_locode_format" CHECK ("un_locode" ~ '^[A-Z]{2}[A-Z2-9]{3}$');
ALTER TABLE "ports" ADD CONSTRAINT "ports_country_code_format" CHECK ("country_code" ~ '^[A-Z]{2}$');

ALTER TABLE "voyages" ADD CONSTRAINT "voyages_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "voyages" ADD CONSTRAINT "voyages_laycan_window_ordered" CHECK ("laycan_end" >= "laycan_start");
ALTER TABLE "voyages" ADD CONSTRAINT "voyages_distinct_ports" CHECK ("load_port_id" <> "discharge_port_id");
