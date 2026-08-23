-- Align Settings table with the current Prisma schema.
-- Idempotent so it is safe if the columns were added manually beforehand.
ALTER TABLE "Settings"
  ADD COLUMN IF NOT EXISTS "sms_template_offer" TEXT,
  ADD COLUMN IF NOT EXISTS "sms_template_no_offer" TEXT,
  ADD COLUMN IF NOT EXISTS "brevoSmsSender" VARCHAR(32);
