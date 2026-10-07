// Node 20 的 --test 不支援 glob，這裡自己找出 src 底下所有 *.test.ts 再交給 node:test
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const files = readdirSync("src", { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile() && d.name.endsWith(".test.ts"))
  .map((d) => join(d.parentPath ?? d.path, d.name));

if (files.length === 0) {
  console.error("找不到任何 *.test.ts");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...process.argv.slice(2), ...files], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
