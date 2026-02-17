// app/routes/app.checkouts.$checkoutId.tsx
import * as React from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

import {
  formatWhen,
  pickLatestJobByCheckout,
  pickRecordingUrl,
  safeStr,
  type SupabaseCallSummary,
} from "../lib/callInsights.shared";
import { fetchSupabaseSummaries } from "../lib/callInsights.server";
import { Modal } from "@shopify/app-bridge-react";

type LoaderData = {
  shop: string;
  checkoutId: string;

  checkout: {
    status: string;
    updatedAt: string;
    abandonedAt: string | null;
    customerName: string | null;
    phone: string | null;
    email: string | null;
    value: number;
    currency: string;
    itemsJson: string | null;
  };

  latestJob: null | {
    id: string;
    status: string;
    createdAt: string;
    scheduledFor: string | null;
    attempts: number;
    providerCallId: string | null;
    recordingUrl: string | null;
  };

  sb: SupabaseCallSummary | null;
  recordingUrl: string | null;
};

function safeSearch(): string {
  if (typeof window === "undefined") return "";
  const s = window.location.search || "";
  return s.startsWith("?") ? s : s ? `?${s}` : "";
}
function withSearch(path: string): string {
  const s = safeSearch();
  if (!s) return path;
  if (path.includes("?")) return path;
  return `${path}${s}`;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const checkoutId = String(params.checkoutId ?? "").trim();
  if (!checkoutId) throw new Response("Missing checkoutId", { status: 400 });

  const [checkout, jobs] = await Promise.all([
    db.checkout.findFirst({
      where: { shop, checkoutId },
      select: {
        checkoutId: true,
        status: true,
        updatedAt: true,
        abandonedAt: true,
        customerName: true,
        phone: true,
        email: true,
        value: true,
        currency: true,
        itemsJson: true,
      },
    }),
    db.callJob.findMany({
      where: { shop, checkoutId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        checkoutId: true,
        status: true,
        scheduledFor: true,
        attempts: true,
        createdAt: true,
        providerCallId: true,
        recordingUrl: true,
      },
    }),
  ]);

  if (!checkout) throw new Response("Checkout not found", { status: 404 });

  const latestJobMap = pickLatestJobByCheckout(jobs);
  const j = latestJobMap.get(String(checkout.checkoutId)) ?? null;

  const callId = j?.providerCallId ? String(j.providerCallId) : "";
  const jobId = j?.id ? String(j.id) : "";

  const sbMap = await fetchSupabaseSummaries({
    shop,
    callIds: callId ? [callId] : [],
    callJobIds: jobId ? [jobId] : [],
    checkoutIds: [checkoutId],
  });

  const sb: SupabaseCallSummary | null =
    (callId ? (sbMap.get(`call:${callId}`) as any) : null) ||
    (jobId ? (sbMap.get(`job:${jobId}`) as any) : null) ||
    (checkoutId ? (sbMap.get(`co:${checkoutId}`) as any) : null) ||
    null;

  const recordingUrl = (pickRecordingUrl(sb) ?? (j?.recordingUrl ? String(j.recordingUrl) : null)) ?? null;

  return {
    shop,
    checkoutId,
    checkout: {
      status: String(checkout.status),
      updatedAt: new Date(checkout.updatedAt).toISOString(),
      abandonedAt: checkout.abandonedAt ? new Date(checkout.abandonedAt).toISOString() : null,
      customerName: checkout.customerName ?? null,
      phone: checkout.phone ?? null,
      email: checkout.email ?? null,
      value: Number(checkout.value ?? 0),
      currency: String(checkout.currency ?? "USD"),
      itemsJson: checkout.itemsJson ?? null,
    },
    latestJob: j
      ? {
          id: String(j.id),
          status: String(j.status),
          createdAt: new Date(j.createdAt).toISOString(),
          scheduledFor: j.scheduledFor ? new Date(j.scheduledFor).toISOString() : null,
          attempts: Number(j.attempts ?? 0),
          providerCallId: j.providerCallId ? String(j.providerCallId) : null,
          recordingUrl: j.recordingUrl ? String(j.recordingUrl) : null,
        }
      : null,
    sb,
    recordingUrl,
  } satisfies LoaderData;
};

function SectionTitle({ children }: { children: any }) {
  return <div style={{ fontWeight: 950, fontSize: 13, margin: "8px 0 6px" }}>{children}</div>;
}

function MonoBox({ children }: { children: any }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: 10,
        borderRadius: 10,
        border: "1px solid rgba(0,0,0,0.12)",
        background: "rgba(0,0,0,0.03)",
        fontSize: 12,
        overflow: "auto",
        maxHeight: 260,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {children}
    </pre>
  );
}

export default function CheckoutDetailModal() {
  const data = useLoaderData<typeof loader>();
  const nav = useNavigate();

  const close = () => nav(withSearch("/app/checkouts"));

  const sb: any = data.sb as any;

  const buyPct =
    typeof sb?.buy_probability === "number" && Number.isFinite(sb.buy_probability) ? Math.round(sb.buy_probability) : null;

  const title = `Checkout ${data.checkoutId}`;

  return (
    <Modal open title={title} onClose={close}>
      <div style={{ padding: 14, display: "grid", gap: 12, maxWidth: 980 }}>
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontWeight: 950 }}>
            {safeStr(data.checkout.customerName) || "-"} · {safeStr(data.checkout.phone) || "-"} · {safeStr(data.checkout.email) || "-"}
          </div>
          <div style={{ opacity: 0.8, fontWeight: 800, fontSize: 12 }}>
            Status: {safeStr(data.checkout.status)} · Updated: {formatWhen(data.checkout.updatedAt)}{" "}
            {data.checkout.abandonedAt ? `· Abandoned: ${formatWhen(data.checkout.abandonedAt)}` : ""}
          </div>
          <div style={{ opacity: 0.8, fontWeight: 800, fontSize: 12 }}>
            Value: {data.checkout.value} {data.checkout.currency}
            {buyPct == null ? "" : ` · Buy: ${buyPct}%`}
            {sb?.call_outcome ? ` · Outcome: ${String(sb.call_outcome).toUpperCase()}` : ""}
            {sb?.ai_status ? ` · AI: ${String(sb.ai_status).toUpperCase()}` : ""}
          </div>

          {data.recordingUrl ? (
            <div>
              <a href={data.recordingUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                <button
                  type="button"
                  style={{
                    padding: "8px 12px",
                    borderRadius: 10,
                    border: "1px solid rgba(0,0,0,0.18)",
                    background: "white",
                    cursor: "pointer",
                    fontWeight: 950,
                    fontSize: 12,
                  }}
                >
                  Open recording
                </button>
              </a>
            </div>
          ) : null}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <SectionTitle>AI summary</SectionTitle>
            <MonoBox>{safeStr(sb?.summary_clean || sb?.summary || "-")}</MonoBox>
          </div>

          <div style={{ minWidth: 0 }}>
            <SectionTitle>Next best action</SectionTitle>
            <MonoBox>{safeStr(sb?.best_next_action || sb?.next_best_action || "-")}</MonoBox>
            <SectionTitle>Follow-up message</SectionTitle>
            <MonoBox>{safeStr(sb?.follow_up_message || "-")}</MonoBox>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <SectionTitle>Key quotes</SectionTitle>
            <MonoBox>{safeStr(sb?.key_quotes_text || "-")}</MonoBox>
          </div>
          <div style={{ minWidth: 0 }}>
            <SectionTitle>Objections</SectionTitle>
            <MonoBox>{safeStr(sb?.objections_text || "-")}</MonoBox>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <SectionTitle>Issues to fix</SectionTitle>
            <MonoBox>{safeStr(sb?.issues_to_fix_text || "-")}</MonoBox>
          </div>
          <div style={{ minWidth: 0 }}>
            <SectionTitle>Tags</SectionTitle>
            <MonoBox>{safeStr(sb?.tagcsv || (Array.isArray(sb?.tags) ? sb.tags.join(", ") : "") || "-")}</MonoBox>
          </div>
        </div>

        <div style={{ minWidth: 0 }}>
          <SectionTitle>Transcript</SectionTitle>
          <MonoBox>{safeStr(sb?.transcript || "-")}</MonoBox>
        </div>

        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: "pointer", fontWeight: 950, fontSize: 12 }}>Raw payload (debug)</summary>
          <MonoBox>
            {(() => {
              try {
                const raw = sb?.payload ?? sb?.end_of_call_report ?? sb?.structured_outputs ?? sb?.ai_result ?? null;
                return raw ? JSON.stringify(raw, null, 2) : "-";
              } catch {
                return "-";
              }
            })()}
          </MonoBox>
        </details>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button
            type="button"
            onClick={close}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.18)",
              background: "white",
              cursor: "pointer",
              fontWeight: 950,
            }}
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
