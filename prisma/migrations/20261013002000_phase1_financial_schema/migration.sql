DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ProjectFinancialStatus') THEN
    CREATE TYPE "ProjectFinancialStatus" AS ENUM ('unpaid', 'partially_paid', 'fully_paid');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChangeOrderStatus') THEN
    CREATE TYPE "ChangeOrderStatus" AS ENUM ('draft', 'pending', 'approved', 'rejected', 'cancelled');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentStatus') THEN
    CREATE TYPE "PaymentStatus" AS ENUM ('recorded', 'partially_allocated', 'allocated', 'voided');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PaymentMethod') THEN
    CREATE TYPE "PaymentMethod" AS ENUM ('cash', 'cheque', 'bank_transfer', 'card', 'e_transfer', 'other');
  END IF;
END $$;

ALTER TYPE "ProjectInvoiceStatus" ADD VALUE IF NOT EXISTS 'issued';
ALTER TYPE "ProjectInvoiceStatus" ADD VALUE IF NOT EXISTS 'partially_paid';
ALTER TYPE "ProjectInvoiceStatus" ADD VALUE IF NOT EXISTS 'voided';

ALTER TABLE "projects"
  ADD COLUMN IF NOT EXISTS "financial_status" "ProjectFinancialStatus" NOT NULL DEFAULT 'unpaid',
  ADD COLUMN IF NOT EXISTS "original_contract" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "total_contract_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "total_received" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "contract_balance" DECIMAL(12, 2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "quote_estimate_subtasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "quote_estimate_id" UUID NOT NULL,
  "quote_task_id" UUID,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "floor_number" INTEGER,
  "unit_name" TEXT,
  "quantity" DECIMAL(12, 2) NOT NULL DEFAULT 1,
  "unit" TEXT,
  "unit_price" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "total_price" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "quote_estimate_subtasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "quote_estimate_materials" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "quote_estimate_id" UUID NOT NULL,
  "quote_task_id" UUID,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "quantity" DECIMAL(12, 2) NOT NULL DEFAULT 1,
  "unit" TEXT,
  "unit_cost" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "total_cost" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "quote_estimate_materials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "change_orders" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "created_by_id" UUID NOT NULL,
  "quote_estimate_id" UUID,
  "number" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "status" "ChangeOrderStatus" NOT NULL DEFAULT 'approved',
  "subtotal" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "total" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "approved_at" TIMESTAMP(3),
  "rejected_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "change_orders_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "change_order_items" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "change_order_id" UUID NOT NULL,
  "task_id" UUID,
  "sub_task_id" UUID,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "quantity" DECIMAL(12, 2) NOT NULL DEFAULT 1,
  "unit" TEXT,
  "unit_value" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "line_total" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "change_order_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "payments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "project_id" UUID NOT NULL,
  "recorded_by_id" UUID NOT NULL,
  "payment_number" TEXT NOT NULL,
  "amount" DECIMAL(12, 2) NOT NULL,
  "allocated_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "unallocated_amount" DECIMAL(12, 2) NOT NULL DEFAULT 0,
  "method" "PaymentMethod" NOT NULL DEFAULT 'other',
  "status" "PaymentStatus" NOT NULL DEFAULT 'recorded',
  "paid_at" TIMESTAMP(3) NOT NULL,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "invoice_payment_allocations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "payment_id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "amount" DECIMAL(12, 2) NOT NULL,
  "allocated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notes" TEXT,

  CONSTRAINT "invoice_payment_allocations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "project_invoices"
  ADD COLUMN IF NOT EXISTS "issued_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "change_orders_number_key" ON "change_orders"("number");
CREATE UNIQUE INDEX IF NOT EXISTS "payments_payment_number_key" ON "payments"("payment_number");
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_payment_allocations_payment_id_invoice_id_key" ON "invoice_payment_allocations"("payment_id", "invoice_id");

CREATE INDEX IF NOT EXISTS "quote_estimate_subtasks_quote_estimate_id_idx" ON "quote_estimate_subtasks"("quote_estimate_id");
CREATE INDEX IF NOT EXISTS "quote_estimate_subtasks_quote_task_id_idx" ON "quote_estimate_subtasks"("quote_task_id");
CREATE INDEX IF NOT EXISTS "quote_estimate_materials_quote_estimate_id_idx" ON "quote_estimate_materials"("quote_estimate_id");
CREATE INDEX IF NOT EXISTS "quote_estimate_materials_quote_task_id_idx" ON "quote_estimate_materials"("quote_task_id");
CREATE INDEX IF NOT EXISTS "change_orders_project_id_idx" ON "change_orders"("project_id");
CREATE INDEX IF NOT EXISTS "change_orders_created_by_id_idx" ON "change_orders"("created_by_id");
CREATE INDEX IF NOT EXISTS "change_orders_status_idx" ON "change_orders"("status");
CREATE INDEX IF NOT EXISTS "change_order_items_change_order_id_idx" ON "change_order_items"("change_order_id");
CREATE INDEX IF NOT EXISTS "change_order_items_task_id_idx" ON "change_order_items"("task_id");
CREATE INDEX IF NOT EXISTS "change_order_items_sub_task_id_idx" ON "change_order_items"("sub_task_id");
CREATE INDEX IF NOT EXISTS "payments_project_id_paid_at_idx" ON "payments"("project_id", "paid_at");
CREATE INDEX IF NOT EXISTS "payments_recorded_by_id_idx" ON "payments"("recorded_by_id");
CREATE INDEX IF NOT EXISTS "payments_status_idx" ON "payments"("status");
CREATE INDEX IF NOT EXISTS "invoice_payment_allocations_invoice_id_idx" ON "invoice_payment_allocations"("invoice_id");
CREATE INDEX IF NOT EXISTS "invoice_payment_allocations_payment_id_idx" ON "invoice_payment_allocations"("payment_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_estimate_subtasks_quote_estimate_id_fkey') THEN
    ALTER TABLE "quote_estimate_subtasks"
      ADD CONSTRAINT "quote_estimate_subtasks_quote_estimate_id_fkey"
      FOREIGN KEY ("quote_estimate_id") REFERENCES "quote_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_estimate_subtasks_quote_task_id_fkey') THEN
    ALTER TABLE "quote_estimate_subtasks"
      ADD CONSTRAINT "quote_estimate_subtasks_quote_task_id_fkey"
      FOREIGN KEY ("quote_task_id") REFERENCES "quote_estimate_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_estimate_materials_quote_estimate_id_fkey') THEN
    ALTER TABLE "quote_estimate_materials"
      ADD CONSTRAINT "quote_estimate_materials_quote_estimate_id_fkey"
      FOREIGN KEY ("quote_estimate_id") REFERENCES "quote_estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_estimate_materials_quote_task_id_fkey') THEN
    ALTER TABLE "quote_estimate_materials"
      ADD CONSTRAINT "quote_estimate_materials_quote_task_id_fkey"
      FOREIGN KEY ("quote_task_id") REFERENCES "quote_estimate_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'change_orders_project_id_fkey') THEN
    ALTER TABLE "change_orders"
      ADD CONSTRAINT "change_orders_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'change_orders_created_by_id_fkey') THEN
    ALTER TABLE "change_orders"
      ADD CONSTRAINT "change_orders_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'change_orders_quote_estimate_id_fkey') THEN
    ALTER TABLE "change_orders"
      ADD CONSTRAINT "change_orders_quote_estimate_id_fkey"
      FOREIGN KEY ("quote_estimate_id") REFERENCES "quote_estimates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'change_order_items_change_order_id_fkey') THEN
    ALTER TABLE "change_order_items"
      ADD CONSTRAINT "change_order_items_change_order_id_fkey"
      FOREIGN KEY ("change_order_id") REFERENCES "change_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_project_id_fkey') THEN
    ALTER TABLE "payments"
      ADD CONSTRAINT "payments_project_id_fkey"
      FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_recorded_by_id_fkey') THEN
    ALTER TABLE "payments"
      ADD CONSTRAINT "payments_recorded_by_id_fkey"
      FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_payment_allocations_invoice_id_fkey') THEN
    ALTER TABLE "invoice_payment_allocations"
      ADD CONSTRAINT "invoice_payment_allocations_invoice_id_fkey"
      FOREIGN KEY ("invoice_id") REFERENCES "project_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_payment_allocations_payment_id_fkey') THEN
    ALTER TABLE "invoice_payment_allocations"
      ADD CONSTRAINT "invoice_payment_allocations_payment_id_fkey"
      FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
