CREATE TYPE "QuoteEstimateStatus" AS ENUM (
  'draft',
  'sent',
  'accepted',
  'converted',
  'rejected',
  'cancelled'
);

CREATE TABLE "quote_estimates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "quote_number" TEXT NOT NULL,
  "company_id" UUID NOT NULL,
  "project_name" TEXT NOT NULL,
  "client_name" TEXT NOT NULL,
  "client_email" TEXT,
  "client_phone" TEXT,
  "project_address" TEXT,
  "project_type" TEXT,
  "property_type" TEXT,
  "unit_type" TEXT,
  "start_date" DATE,
  "end_date" DATE,
  "floors_count" INTEGER,
  "units_per_floor" INTEGER,
  "total_units" INTEGER,
  "subtotal" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "discount_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "tax_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "total_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "status" "QuoteEstimateStatus" NOT NULL DEFAULT 'draft',
  "sent_at" TIMESTAMP(3),
  "accepted_at" TIMESTAMP(3),
  "rejected_at" TIMESTAMP(3),
  "converted_project_id" UUID,
  "created_by_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "quote_estimates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "quote_estimate_tasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "quote_estimate_id" UUID NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "floor_number" INTEGER,
  "unit_name" TEXT,
  "quantity" DECIMAL(12, 2) NOT NULL DEFAULT 1,
  "unit" TEXT,
  "estimated_hours" DECIMAL(12, 2),
  "unit_price" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "total_price" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "quote_estimate_tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "quote_acceptances" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "quote_estimate_id" UUID NOT NULL,
  "accepted_by_name" TEXT,
  "notes" TEXT,
  "accepted_by_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "quote_acceptances_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "quote_estimates_quote_number_key" ON "quote_estimates"("quote_number");
CREATE UNIQUE INDEX "quote_estimates_converted_project_id_key" ON "quote_estimates"("converted_project_id");
CREATE INDEX "quote_estimates_company_id_idx" ON "quote_estimates"("company_id");
CREATE INDEX "quote_estimates_created_by_id_idx" ON "quote_estimates"("created_by_id");
CREATE INDEX "quote_estimates_status_idx" ON "quote_estimates"("status");
CREATE INDEX "quote_estimate_tasks_quote_estimate_id_idx" ON "quote_estimate_tasks"("quote_estimate_id");
CREATE INDEX "quote_acceptances_accepted_by_id_idx" ON "quote_acceptances"("accepted_by_id");
CREATE INDEX "quote_acceptances_quote_estimate_id_idx" ON "quote_acceptances"("quote_estimate_id");

ALTER TABLE "quote_estimates"
  ADD CONSTRAINT "quote_estimates_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "quote_estimates"
  ADD CONSTRAINT "quote_estimates_converted_project_id_fkey"
  FOREIGN KEY ("converted_project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "quote_estimates"
  ADD CONSTRAINT "quote_estimates_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "quote_estimate_tasks"
  ADD CONSTRAINT "quote_estimate_tasks_quote_estimate_id_fkey"
  FOREIGN KEY ("quote_estimate_id") REFERENCES "quote_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "quote_acceptances"
  ADD CONSTRAINT "quote_acceptances_accepted_by_id_fkey"
  FOREIGN KEY ("accepted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "quote_acceptances"
  ADD CONSTRAINT "quote_acceptances_quote_estimate_id_fkey"
  FOREIGN KEY ("quote_estimate_id") REFERENCES "quote_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
