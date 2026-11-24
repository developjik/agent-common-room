import { openDb } from "./db.js";
import { RoomService } from "./service.js";
import { createApp } from "./http.js";
import { hashToken, newToken } from "./crypto.js";

const dbPath = process.env.ACR_DB ?? "./data/room.db";
const host = process.env.ACR_HOST ?? "127.0.0.1";
const port = Number(process.env.ACR_PORT ?? 8787);

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
mkdirSync(dirname(dbPath), { recursive: true });

const svc = new RoomService(openDb(dbPath));
const envKey = process.env.ACR_ADMIN_KEY;
if (envKey) {
  if (envKey.length < 24) { console.error("ACR_ADMIN_KEY는 24자 이상이어야 합니다."); process.exit(1); }
  svc.setAdminKeyHash(hashToken(envKey));
} else if (!svc.hasAdminKey()) {
  const key = newToken("acr_adm");
  svc.setAdminKeyHash(hashToken(key));
  console.error("\n=== 관리자 키(처음 한 번만 표시됩니다. 안전한 곳에 저장하세요) ===\n" + key + "\n");
}

svc.purgeExpired();
setInterval(() => svc.purgeExpired(), 3600_000).unref();

const app = createApp(svc, { publicUrl: process.env.ACR_PUBLIC_URL });
app.listen(port, host, () => console.log(`agent-common-room listening on http://${host}:${port}`));
