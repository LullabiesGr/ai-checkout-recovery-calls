// app/routes/_index/route.tsx
import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // κρατάει embedded params (host, shop, etc)
  const qs = url.search || "";
  return redirect(`/app${qs}`);
};

export default function Index() {
  return null;
}
