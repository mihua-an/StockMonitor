// Rotations in the same millisecond keep their order: the name was only millisecond-precise and then random, so
// pruning could remove the newest generation and keep an older one.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { rotateIfLarger } = require("../service/platform/js/atomic_files.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rotation-order-"));
try {
  const file = path.join(dir, "error-electron.log");
  const now = () => 1_762_700_000_123;
  for (let n = 0; n < 20; n += 1) {
    fs.writeFileSync(file, `${n}\n`.repeat(100), "utf8");
    await rotateIfLarger(file, 10, { now });
  }
  const kept = fs.readdirSync(dir).filter((name) => name !== "error-electron.log").sort();
  assert.deepEqual(kept.map((name) => fs.readFileSync(path.join(dir, name), "utf8").split("\n")[0]), ["17", "18", "19"]);
  console.log("atomic_files_rotation_order: ok");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
