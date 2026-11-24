import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { start } from "./helpers.js";

let t: Awaited<ReturnType<typeof start>>;
before(async () => { t = await start(); });
after(async () => { await t.close(); });

async function connect(token: string) {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(t.base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}
const parse = (r: any) => JSON.parse(r.content[0].text);

test("공식 MCP 클라이언트 E2E: 도구 목록, 전송, inbox, ack", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "alpha", { history: "all" });
  const b = await t.join(r, "beta", { history: "all" });
  const ca = await connect(a.token);
  const cb = await connect(b.token);
  const tools = (await ca.listTools()).tools.map(x => x.name).sort();
  assert.deepEqual(tools, ["ack", "post_message", "read_inbox", "read_messages", "room_info"]);

  const info = parse(await ca.callTool({ name: "room_info", arguments: {} }));
  assert.equal(info.you.name, "alpha");
  assert.equal(info.participants.length, 2);

  const posted = parse(await ca.callTool({ name: "post_message", arguments: { client_id: "mcp-1", content: "MCP에서 안녕", kind: "question", recipient: "beta" } }));
  assert.equal(posted.message.seq, 1);
  assert.equal(posted.message.sender.name, "alpha");
  const again = parse(await ca.callTool({ name: "post_message", arguments: { client_id: "mcp-1", content: "MCP에서 안녕", kind: "question", recipient: "beta" } }));
  assert.equal(again.duplicate, true);
  const conflict = await ca.callTool({ name: "post_message", arguments: { client_id: "mcp-1", content: "다름" } });
  assert.equal(conflict.isError, true);
  assert.equal(parse(conflict).error.code, "client_id_conflict");

  const inbox = parse(await cb.callTool({ name: "read_inbox", arguments: {} }));
  assert.equal(inbox.messages.length, 1);
  assert.match(inbox.notice, /untrusted/);
  assert.equal(parse(await cb.callTool({ name: "read_inbox", arguments: {} })).messages[0].redelivered, true);
  assert.equal(parse(await cb.callTool({ name: "ack", arguments: { seq: 1 } })).acked_seq, 1);
  assert.equal(parse(await cb.callTool({ name: "read_inbox", arguments: {} })).messages.length, 0);
  const rd = parse(await cb.callTool({ name: "read_messages", arguments: { after: 0 } }));
  assert.equal(rd.messages.length, 1);

  // HTTP과 MCP는 같은 상태를 본다
  assert.equal((await t.call("GET", "/api/inbox", b.token)).json.acked_seq, 1);
  await ca.close(); await cb.close();
});

test("MCP: 잘못된 토큰과 폐기된 토큰은 연결 불가, GET은 405", async () => {
  const r = await t.setupRoom();
  const a = await t.join(r, "alpha");
  await assert.rejects(connect("acr_agt_invalid"));
  const ok = await connect(a.token);
  await ok.close();
  await t.call("POST", `/api/owner/agents/${a.id}/revoke`, r.sess, {});
  await assert.rejects(connect(a.token));
  const g = await fetch(t.base + "/mcp", { headers: { authorization: `Bearer ${a.token}` } });
  assert.equal(g.status, 401);
});
