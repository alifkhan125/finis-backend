ALTER TABLE "attendances" ADD COLUMN "calculation" JSONB;
ALTER TABLE "time_adjustment_requests"
 ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'correction',
 ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'single_day',
 ADD COLUMN "schedule_id" UUID,
 ADD COLUMN "session_id" UUID,
 ADD COLUMN "start_time" TEXT,
 ADD COLUMN "end_time" TEXT;
UPDATE "time_adjustment_requests" SET "kind" = 'shift_change', "scope" = 'regular'
 WHERE "reason" LIKE '%[Scope: regular]%';
CREATE TABLE "attendance_shift_revisions" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "user_id" UUID NOT NULL,
 "company_id" UUID, "schedule_id" UUID, "request_id" UUID UNIQUE,
 "effective_from" DATE NOT NULL, "effective_to" DATE,
 "start_time" TEXT NOT NULL, "end_time" TEXT NOT NULL, "days" "ShiftDay"[] NOT NULL,
 "grace_minutes" INTEGER NOT NULL DEFAULT 15 CHECK ("grace_minutes" BETWEEN 0 AND 180),
 "approved_by" UUID, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "attendance_shift_revisions_user_id_effective_from_idx"
 ON "attendance_shift_revisions"("user_id", "effective_from");
INSERT INTO "attendance_shift_revisions" ("user_id", "company_id", "schedule_id", "effective_from", "start_time", "end_time", "days", "grace_minutes", "created_at")
 SELECT a."user_id", s."company_id", s."id", a."assigned_at"::date, s."start_time", s."end_time", s."days", s."grace_minutes", a."assigned_at"
 FROM "work_schedule_assignments" a JOIN "work_schedules" s ON s."id" = a."schedule_id";
