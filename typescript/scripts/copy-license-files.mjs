/**
 * Copies the repo-root LICENSE and NOTICE into the package being packed.
 *
 * npm always includes LICENSE. NOTICE is listed in each package's "files".
 * @x402/evm already has an attribution NOTICE; prepare prepends the repository
 * NOTICE for the tarball and postpack restores the original. Copied files stay
 * on disk because pnpm stats them after postpack, and they are gitignored.
 */
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkgDir = process.cwd();
const licenseDest = resolve(pkgDir, "LICENSE");
const noticeDest = resolve(pkgDir, "NOTICE");
const backupPath = resolve(pkgDir, ".notice-pack-backup");

const action = process.argv[2];

if (action === "prepare") {
  prepare();
} else if (action === "restore") {
  restore();
} else {
  console.error("usage: copy-license-files.mjs prepare|restore");
  process.exit(1);
}

function prepare() {
  copyFileSync(resolve(repoRoot, "LICENSE"), licenseDest);
  const repoNotice = readFileSync(resolve(repoRoot, "NOTICE"));
  if (!existsSync(noticeDest)) {
    writeFileSync(noticeDest, repoNotice);
    return;
  }
  const local = readFileSync(noticeDest);
  if (local.subarray(0, repoNotice.length).equals(repoNotice)) {
    return;
  }
  writeFileSync(backupPath, local);
  writeFileSync(noticeDest, Buffer.concat([repoNotice, Buffer.from("\n"), local]));
}

function restore() {
  // pnpm stats packed paths after postpack, so the copied LICENSE and NOTICE
  // stay on disk. They are gitignored. A package NOTICE that existed before
  // prepare (currently @x402/evm) is put back so the checkout stays clean.
  if (!existsSync(backupPath)) {
    return;
  }
  copyFileSync(backupPath, noticeDest);
  unlinkSync(backupPath);
}
