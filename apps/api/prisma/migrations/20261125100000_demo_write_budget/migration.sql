-- Portfolio-demo write budget (ADR 0021): the business commands this database has admitted.
-- At most one row (id 1). It is created by the first admitted command and only ever counts up,
-- so its absence means nothing has been admitted yet.
CREATE TABLE "demo_write_budget" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "admitted" INTEGER NOT NULL,

    CONSTRAINT "demo_write_budget_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "demo_write_budget_single_row" CHECK ("id" = 1),
    CONSTRAINT "demo_write_budget_admitted_positive" CHECK ("admitted" > 0)
);
