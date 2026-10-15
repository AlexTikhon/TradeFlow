-- CreateTable
CREATE TABLE "trade_contracts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "voyage_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "seller_participant_id" UUID NOT NULL,
    "buyer_participant_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trade_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trade_contracts_voyage_id_position_key" ON "trade_contracts"("voyage_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "trade_contracts_voyage_id_seller_participant_id_key" ON "trade_contracts"("voyage_id", "seller_participant_id");

-- CreateIndex
CREATE UNIQUE INDEX "trade_contracts_voyage_id_buyer_participant_id_key" ON "trade_contracts"("voyage_id", "buyer_participant_id");

-- CreateIndex
CREATE UNIQUE INDEX "voyage_participants_voyage_id_id_key" ON "voyage_participants"("voyage_id", "id");

-- AddForeignKey
ALTER TABLE "trade_contracts" ADD CONSTRAINT "trade_contracts_voyage_id_fkey" FOREIGN KEY ("voyage_id") REFERENCES "voyages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trade_contracts" ADD CONSTRAINT "trade_contracts_voyage_id_seller_participant_id_fkey" FOREIGN KEY ("voyage_id", "seller_participant_id") REFERENCES "voyage_participants"("voyage_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "trade_contracts" ADD CONSTRAINT "trade_contracts_voyage_id_buyer_participant_id_fkey" FOREIGN KEY ("voyage_id", "buyer_participant_id") REFERENCES "voyage_participants"("voyage_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;


-- ---------------------------------------------------------------------------
-- Hand-written invariants (Prisma schema cannot express these).
-- Row-level rules only. Rules about the chain as a whole (contiguous positions, adjacent
-- contracts connecting, exporter first, final buyer last, traders between them, no service
-- providers) are checked by the voyages module's domain validation.
-- ---------------------------------------------------------------------------

-- Positions are 1-based.
ALTER TABLE "trade_contracts" ADD CONSTRAINT "trade_contracts_position_positive" CHECK ("position" > 0);

-- Nobody sells to themselves.
ALTER TABLE "trade_contracts" ADD CONSTRAINT "trade_contracts_distinct_counterparties" CHECK ("seller_participant_id" <> "buyer_participant_id");
