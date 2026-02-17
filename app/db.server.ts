// app/db.server.ts
import { PrismaClient } from "@prisma/client";

let prisma: PrismaClient;

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

if (process.env.NODE_ENV === "production") {
  prisma = new PrismaClient();
} else {
  prisma = global.__prisma ?? new PrismaClient();
  global.__prisma = prisma;
}

export default prisma;
