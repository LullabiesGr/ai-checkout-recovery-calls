-- CreateEnum
CREATE TYPE "public"."BillingPlan" AS ENUM ('FREE', 'STARTER', 'PRO', 'SCALE', 'PAYG');

-- CreateEnum
CREATE TYPE "public"."BillingStatus" AS ENUM ('NONE', 'PENDING', 'ACTIVE', 'CANCELLED');

-- CreateTable
CREATE TABLE "public"."ShopBilling" (
  "shop" TEXT NOT NULL,
  "plan" "public"."BillingPlan" NOT NULL DEFAULT 'FREE',
  "status" "public"."BillingStatus" NOT NULL DEFAULT 'NONE',

  "currencyCode" TEXT NOT NULL DEFAULT 'EUR',
  "subscriptionId" TEXT,
  "usageLineItemId" TEXT,
  "recurringLineItemId" TEXT,

  "currentPeriodStart" TIMESTAMP(3),
  "currentPeriodEnd" TIMESTAMP(3),

  "includedSecondsUsed" INTEGER NOT NULL DEFAULT 0,
  "freeSecondsUsed" INTEGER NOT NULL DEFAULT 0,

  "pendingPlan" "public"."BillingPlan",

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ShopBilling_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "public"."CallCharge" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "callJobId" TEXT NOT NULL,

  "connectedSeconds" INTEGER NOT NULL,
  "minutesBilled" INTEGER NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "currencyCode" TEXT NOT NULL,

  "usageRecordId" TEXT,
  "idempotencyKey" TEXT NOT NULL,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CallCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CallCharge_callJobId_key" ON "public"."CallCharge"("callJobId");

-- CreateIndex
CREATE UNIQUE INDEX "CallCharge_idempotencyKey_key" ON "public"."CallCharge"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CallCharge_shop_createdAt_idx" ON "public"."CallCharge"("shop", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."CallCharge"
ADD CONSTRAINT "CallCharge_shop_fkey"
FOREIGN KEY ("shop") REFERENCES "public"."ShopBilling"("shop")
ON DELETE CASCADE ON UPDATE CASCADE;