// app/routes/api.vapi-tools.ts
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { handleVapiToolsWebhook } from "../callProvider.server";

export async function action({ request }: ActionFunctionArgs) {
  return handleVapiToolsWebhook(request);
}

export async function loader({ request }: LoaderFunctionArgs) {
  return handleVapiToolsWebhook(request);
}
