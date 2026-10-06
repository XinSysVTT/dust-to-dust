#!/usr/bin/env node
// Deploy Dust to Dust into the local Foundry data directory.
//
//   node tools/deploy.mjs             # create a directory junction (default)
//   node tools/deploy.mjs --copy      # copy files instead of linking
//   node tools/deploy.mjs --remove    # remove the deployed link/copy
//
// The Foundry data path defaults to C:/Users/vilks/AppData/Local/FoundryVTT
// and can be overridden with the FOUNDRY_DATA environment variable.

import { existsSync, mkdirSync, rmSync, cpSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const args = new Set(process.argv.slice(2));
const dataRoot = process.env.FOUNDRY_DATA ?? "C:/Users/vilks/AppData/Local/FoundryVTT";
const modulesDir = join(dataRoot, "modules");
const target = join(modulesDir, "dust-to-dust");

function remove() {
  if (!existsSync(target)) {
    console.log(`Nothing to remove at ${target}`);
    return;
  }
  rmSync(target, { recursive: true, force: true });
  console.log(`Removed ${target}`);
}

if (args.has("--remove")) {
  remove();
  process.exit(0);
}

if (!existsSync(modulesDir)) {
  mkdirSync(modulesDir, { recursive: true });
}

if (args.has("--copy")) {
  remove();
  cpSync(repoRoot, target, {
    recursive: true,
    filter: (src) => !src.includes(`${repoRoot}/.git`) && !src.endsWith(".zip"),
  });
  console.log(`Copied module to ${target}`);
  process.exit(0);
}

if (existsSync(target)) {
  console.log(`Already deployed at ${target} (use --remove first to redeploy)`);
  process.exit(0);
}

try {
  symlinkSync(repoRoot, target, "junction");
  console.log(`Junction created: ${target} -> ${repoRoot}`);
} catch (err) {
  console.error(`Junction failed (${err.message}); falling back to a copy.`);
  cpSync(repoRoot, target, {
    recursive: true,
    filter: (src) => !src.includes(`${repoRoot}/.git`) && !src.endsWith(".zip"),
  });
  console.log(`Copied module to ${target}`);
}
