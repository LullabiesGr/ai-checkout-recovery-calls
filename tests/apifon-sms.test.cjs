const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

function compileApifon({ env, fetch }) {
  const exports = {};
  const source = fs.readFileSync("app/lib/apifonSms.server.ts", "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(output, {
    exports,
    require: (name) => {
      if (name === "node:crypto") return require("node:crypto");
      throw new Error(name);
    },
    process: { env },
    fetch,
    URLSearchParams,
  });
  return exports;
}

test("Apifon exchanges API Token and API Key for an OAuth access token", async () => {
  const requests = [];
  const api = compileApifon({
    env: { APIFON_API_TOKEN: "client-id", APIFON_API_KEY: "client-secret" },
    fetch: async (url, options) => {
      if (url === "https://ids.apifon.com/oauth2/token") {
        requests.push({ url, options, body: String(options.body) });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ access_token: "access-token" }),
        };
      }
      requests.push({ url, options, body: JSON.parse(options.body) });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          request_id: "request-1",
          results: { "306900000000": [{ message_id: "message-1" }] },
          result_info: { status_code: 200 },
        }),
      };
    },
  });

  const result = await api.sendApifonSms({
    toE164: "+30 690 000 0000",
    content: "Complete checkout",
    sender: "Lux Nails",
  });

  assert.equal(result.messageId, "message-1");
  assert.equal(requests[0].url, "https://ids.apifon.com/oauth2/token");
  assert.match(requests[0].body, /client_id=client-id/);
  assert.match(requests[0].body, /client_secret=client-secret/);
  assert.equal(requests[1].url, "https://ars.apifon.com/services/api/v1/sms/send");
  assert.equal(requests[1].body.subscribers[0].number, "306900000000");
  assert.equal(requests[1].body.message.sender_id, "LuxNails");
  assert.equal(requests[1].options.headers.Authorization, "Bearer access-token");
});

test("Apifon retries a rejected merchant sender as CartEcho", async () => {
  const senders = [];
  const api = compileApifon({
    env: { APIFON_API_TOKEN: "client-id", APIFON_API_KEY: "client-secret" },
    fetch: async (url, options) => {
      if (url === "https://ids.apifon.com/oauth2/token") {
        return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "access-token" }) };
      }
      const sender = JSON.parse(options.body).message.sender_id;
      senders.push(sender);
      if (senders.length === 1) {
        return { ok: false, status: 400, text: async () => "sender rejected" };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ request_id: "request-2", result_info: { status_code: 200 } }),
      };
    },
  });

  const result = await api.sendApifonSms({
    toE164: "+306900000000",
    content: "Complete checkout",
    sender: "Merchant",
  });

  assert.deepEqual(senders, ["Merchant", "CartEcho"]);
  assert.equal(result.sender, "CartEcho");
});
