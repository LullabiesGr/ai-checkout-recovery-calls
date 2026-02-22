// app/routes/admin.billing.tsx
import * as React from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  DataTable,
  Badge,
  Banner,
} from "@shopify/polaris";

type Row = {
  shop: string;
  plan: string;
  status: string;
  currentPeriodEnd: string | null;
  includedSecondsUsed: number;
  freeSecondsUsed: number;
  chargesCount: number;
  updatedAt: string;
};

type LoaderData = {
  rows: Row[];
};

function mustAdminKey(request: Request) {
  const expected = process.env.ADMIN_DASHBOARD_KEY ?? "";
  const url = new URL(request.url);
  const got = url.searchParams.get("key") ?? "";
  if (!expected || got !== expected) throw new Response("Not Found", { status: 404 });
}

function badgeToneFromStatus(status: string) {
  const s = String(status || "").toUpperCase();
  if (s === "ACTIVE") return "success" as const;
  if (s === "PENDING") return "warning" as const;
  if (s === "CANCELLED") return "critical" as const;
  return "info" as const;
}

function fmtDate(v: string | null) {
  if (!v) return "-";
  const d = new Date(v);
  if (!Number.isFinite(d.getTime())) return "-";
  return d.toISOString().slice(0, 10);
}

export async function loader({ request }: LoaderFunctionArgs) {
  mustAdminKey(request);

  const list = await db.shopBilling.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      shop: true,
      plan: true,
      status: true,
      currentPeriodEnd: true,
      includedSecondsUsed: true,
      freeSecondsUsed: true,
      updatedAt: true,
      _count: { select: { charges: true } },
    },
    take: 500,
  });

  const rows: Row[] = list.map((r) => ({
    shop: r.shop,
    plan: String(r.plan ?? "FREE"),
    status: String(r.status ?? "NONE"),
    currentPeriodEnd: r.currentPeriodEnd ? r.currentPeriodEnd.toISOString() : null,
    includedSecondsUsed: Number(r.includedSecondsUsed || 0),
    freeSecondsUsed: Number(r.freeSecondsUsed || 0),
    chargesCount: Number(r._count?.charges || 0),
    updatedAt: r.updatedAt.toISOString(),
  }));

  return { rows } satisfies LoaderData;
}

export default function AdminBilling() {
  const { rows } = useLoaderData<typeof loader>();

  const tableRows = rows.map((r) => {
    const includedMin = Math.floor((r.includedSecondsUsed || 0) / 60);
    const freeMin = Math.floor((r.freeSecondsUsed || 0) / 60);

    return [
      r.shop,
      r.plan,
      <Badge key={`${r.shop}-st`} tone={badgeToneFromStatus(r.status)}>{r.status}</Badge>,
      fmtDate(r.currentPeriodEnd),
      `${includedMin} min`,
      `${freeMin} min`,
      String(r.chargesCount),
      fmtDate(r.updatedAt),
    ];
  });

  return (
    <Page title="Admin Billing">
      <Layout>
        <Layout.Section>
          <Banner tone="warning" title="Private admin page">
            <p>Do not share this URL.</p>
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Shops
              </Text>

              <DataTable
                columnContentTypes={[
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                  "text",
                  "numeric",
                  "text",
                ]}
                headings={[
                  "Shop",
                  "Plan",
                  "Status",
                  "Period end",
                  "Included used",
                  "Free used",
                  "Charges",
                  "Updated",
                ]}
                rows={tableRows as any}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);