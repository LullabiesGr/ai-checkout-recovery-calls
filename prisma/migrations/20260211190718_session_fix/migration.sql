ALTER TABLE "Session"
  ADD COLUMN IF NOT EXISTS "refreshToken" TEXT,
  ADD COLUMN IF NOT EXISTS "refreshTokenExpires" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Session_shop_idx" ON "Session"("shop");