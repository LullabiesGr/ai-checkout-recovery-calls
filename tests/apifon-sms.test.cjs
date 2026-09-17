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
  });
  return exports;
}

test("Apifon sends with HMAC credentials from one Render secret", async () => {
  const requests = [];
  const api = compileApifon({
    env: { APIFON_API_KEY: "token:secret" },
    fetch: async (url, options) => {
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
  assert.equal(requests[0].url, "https://ars.apifon.com/services/api/v1/sms/send");
  assert.equal(requests[0].body.subscribers[0].number, "306900000000");
  assert.equal(requests[0].body.message.sender_id, "LuxNails");
  assert.match(requests[0].options.headers.Authorization, /^ApifonWS token:/);
  assert.ok(requests[0].options.headers["X-ApifonWS-Date"]);
});

test("Apifon retries a rejected merchant sender as CartEcho", async () => {
  const senders = [];
  const api = compileApifon({
    env: { APIFON_API_KEY: "token:secret" },
    fetch: async (_url, options) => {
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
