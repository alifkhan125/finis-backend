ALTER TABLE "work_schedules" ADD COLUMN "grace_minutes" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "work_schedules" ADD CONSTRAINT "work_schedules_grace_minutes_check" CHECK ("grace_minutes" BETWEEN 0 AND 180);
