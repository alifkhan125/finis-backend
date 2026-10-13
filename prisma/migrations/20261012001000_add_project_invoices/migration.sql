CREATE TYPE "ProjectInvoiceStatus" AS ENUM ('draft', 'sent', 'paid', 'cancelled');

CREATE TABLE "project_invoices" (
  "id" UUID NOT NULL,
  "project_id" UUID NOT NULL,
  "created_by_id" UUID NOT NULL,
  "invoice_number" TEXT NOT NULL,
  "status" "ProjectInvoiceStatus" NOT NULL DEFAULT 'draft',
  "start_date" TIMESTAMP(3) NOT NULL,
  "end_date" TIMESTAMP(3) NOT NULL,
  "billable_units" INTEGER NOT NULL DEFAULT 0,
  "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "project_invoices_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "project_invoice_lines" (
  "id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "sub_task_id" UUID NOT NULL,
  "task_id" UUID NOT NULL,
  "task_title" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "unit_name" TEXT,
  "floor_name" TEXT,
  "worker_name" TEXT,
  "completed_at" TIMESTAMP(3) NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "unit_value" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "line_total" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "project_invoice_lines_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_invoices_invoice_number_key" ON "project_invoices"("invoice_number");
CREATE INDEX "project_invoices_project_id_start_date_end_date_idx" ON "project_invoices"("project_id", "start_date", "end_date");
CREATE INDEX "project_invoices_created_by_id_idx" ON "project_invoices"("created_by_id");
CREATE INDEX "project_invoice_lines_invoice_id_idx" ON "project_invoice_lines"("invoice_id");
CREATE INDEX "project_invoice_lines_sub_task_id_idx" ON "project_invoice_lines"("sub_task_id");

ALTER TABLE "project_invoices" ADD CONSTRAINT "project_invoices_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_invoices" ADD CONSTRAINT "project_invoices_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "project_invoice_lines" ADD CONSTRAINT "project_invoice_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "project_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_invoice_lines" ADD CONSTRAINT "project_invoice_lines_sub_task_id_fkey" FOREIGN KEY ("sub_task_id") REFERENCES "sub_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
