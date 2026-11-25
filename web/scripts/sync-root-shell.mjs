// Vite 산출물(public/app/index.html)을 루트 셸(public/index.html)로 복사한다.
// Cloudflare Workers Static Assets는 "/"에 public/index.html을 돌려주므로, 두 파일이 같아야
// Node·Vercel(runtime이 public/app을 직접 읽음)과 Workers가 같은 화면을 서빙한다.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const built = resolve(here, "../../public/app/index.html");
const out = resolve(here, "../../public/index.html");

const html = readFileSync(built, "utf8");
if (!html.includes("/app/assets/")) {
  throw new Error("빌드된 index.html이 /app/assets/ 를 가리키지 않습니다. vite.config.ts의 base를 확인하세요.");
}
writeFileSync(out, html);
console.log("public/index.html ← public/app/index.html");
