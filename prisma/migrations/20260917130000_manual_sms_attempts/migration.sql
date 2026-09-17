CREATE TABLE "SmsDelivery" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "checkoutId" TEXT NOT NULL,
    "customerKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "idempotencyKey" TEXT NOT NULL,
    "attemptSource" TEXT NOT NULL,
    "attemptPeriodEnd" TIMESTAMP(3),
    "messageId" TEXT,
    "sender" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmsDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SmsDelivery_idempotencyKey_key" ON "SmsDelivery"("idempotencyKey");
CREATE INDEX "SmsDelivery_shop_customerKey_status_idx" ON "SmsDelivery"("shop", "customerKey", "status");
CREATE INDEX "SmsDelivery_shop_checkoutId_createdAt_idx" ON "SmsDelivery"("shop", "checkoutId", "createdAt");
