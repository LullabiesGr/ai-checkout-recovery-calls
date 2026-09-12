ALTER TABLE "ShopBilling" ADD COLUMN "extraAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CallCharge" ADD COLUMN "attemptSource" TEXT NOT NULL DEFAULT 'LEGACY', ADD COLUMN "attemptPeriodEnd" TIMESTAMP(3);
CREATE TABLE "AttemptPurchase" (
 "id" TEXT NOT NULL PRIMARY KEY, "shop" TEXT NOT NULL, "shopifyPurchaseId" TEXT,
 "attempts" INTEGER NOT NULL, "amountCents" INTEGER NOT NULL, "test" BOOLEAN NOT NULL DEFAULT false,
 "creditedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "AttemptPurchase_shop_fkey" FOREIGN KEY ("shop") REFERENCES "ShopBilling"("shop") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AttemptPurchase_shopifyPurchaseId_key" ON "AttemptPurchase"("shopifyPurchaseId");
CREATE INDEX "AttemptPurchase_shop_creditedAt_idx" ON "AttemptPurchase"("shop", "creditedAt");
