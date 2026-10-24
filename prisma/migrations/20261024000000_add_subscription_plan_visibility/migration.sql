ALTER TABLE "subscription_plans"
ADD COLUMN IF NOT EXISTS "visibility" TEXT NOT NULL DEFAULT 'public';
