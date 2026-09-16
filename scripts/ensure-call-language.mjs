// The existing Render start command does not run Prisma migrations. Apply only
// this additive migration before serving the new Prisma client. Do not run the
// unrelated historical migration backlog or print connection strings.
import { PrismaClient } from '@prisma/client';
import { readFile } from 'node:fs/promises';
const db = new PrismaClient();
try {
  const sql = await readFile(new URL('../prisma/migrations/20260916090000_call_language/migration.sql', import.meta.url), 'utf8');
  await db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '15s'");
    await tx.$executeRawUnsafe(sql);
  }, { timeout: 20000 });
  console.log('Call language schema ready');
} catch {
  console.error('Call language migration failed. New server was not started; check database permissions/connectivity.');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
