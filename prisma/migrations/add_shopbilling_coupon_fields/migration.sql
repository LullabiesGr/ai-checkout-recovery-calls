ALTER TABLE "ShopBilling"
  ADD COLUMN IF NOT EXISTS "pendingCouponCode" TEXT,
  ADD COLUMN IF NOT EXISTS "pendingCouponId" UUID,
  ADD COLUMN IF NOT EXISTS "appliedCouponCode" TEXT;