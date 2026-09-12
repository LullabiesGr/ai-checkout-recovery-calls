-- CreateTable
CREATE TABLE "PrivacyRequest" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "payload" JSONB,
    "report" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacySuppression" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrivacySuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportInquiry" (
    "id" TEXT NOT NULL,
    "shop" TEXT,
    "email" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportInquiry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PrivacyRequest_shop_createdAt_idx" ON "PrivacyRequest"("shop", "createdAt");

-- CreateIndex
CREATE INDEX "PrivacyRequest_status_createdAt_idx" ON "PrivacyRequest"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PrivacySuppression_shop_digest_key" ON "PrivacySuppression"("shop", "digest");

-- CreateIndex
CREATE INDEX "SupportInquiry_email_createdAt_idx" ON "SupportInquiry"("email", "createdAt");

-- These records are accessed only by the server's database role, never by browser Data API clients.
ALTER TABLE "PrivacyRequest" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "PrivacySuppression" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SupportInquiry" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "PrivacyRequest", "PrivacySuppression", "SupportInquiry" FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "PrivacyRequest", "PrivacySuppression", "SupportInquiry" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "PrivacyRequest", "PrivacySuppression", "SupportInquiry" FROM authenticated;
  END IF;
END $$;

-- Existing Prisma models contain credentials or merchant/customer records and are server-only too.
-- Table owners/service roles retain access; anonymous/browser API roles must not access them.
DO $$
DECLARE app_table TEXT;
BEGIN
  FOREACH app_table IN ARRAY ARRAY['Session','Checkout','Order','CallJob','Settings','ShopBilling','CallCharge','BillingCoupon','BillingCouponRedemption','AttemptPurchase']
  LOOP
    IF to_regclass(format('public.%I', app_table)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', app_table);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', app_table);
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', app_table);
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', app_table);
      END IF;
    END IF;
  END LOOP;
END $$;
