-- 20260221_add_prompt_mode
-- Safe / idempotent migration for Supabase Postgres

-- 1) Create enum type if missing
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PromptMode') THEN
    CREATE TYPE "PromptMode" AS ENUM ('append', 'replace', 'default_only');
  END IF;
END$$;

-- 2) Ensure Settings.promptMode exists and is the enum
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='Settings' AND column_name='promptMode'
  ) THEN
    ALTER TABLE public."Settings"
      ADD COLUMN "promptMode" "PromptMode" NOT NULL DEFAULT 'append';
  ELSE
    -- If it's not already the enum, convert it
    IF EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='Settings' AND column_name='promptMode'
        AND udt_name <> 'PromptMode'
    ) THEN
      ALTER TABLE public."Settings"
        ALTER COLUMN "promptMode" DROP DEFAULT;

      ALTER TABLE public."Settings"
        ALTER COLUMN "promptMode" TYPE "PromptMode"
        USING (
          CASE
            WHEN "promptMode" IS NULL THEN 'append'::"PromptMode"
            WHEN lower(trim("promptMode"::text)) IN ('append','replace','default_only')
              THEN lower(trim("promptMode"::text))::"PromptMode"
            ELSE 'append'::"PromptMode"
          END
        );

      ALTER TABLE public."Settings"
        ALTER COLUMN "promptMode" SET DEFAULT 'append';

      ALTER TABLE public."Settings"
        ALTER COLUMN "promptMode" SET NOT NULL;
    END IF;
  END IF;
END$$;

-- 3) Your UI writes NULLs here; make them nullable
ALTER TABLE public."Settings"
  ALTER COLUMN "min_cart_value_for_discount" DROP NOT NULL;

ALTER TABLE public."Settings"
  ALTER COLUMN "coupon_prefix" DROP NOT NULL;