// ============================================================================
//  reset.mjs — delete test junk created AFTER a snapshot (org data reset)
// ============================================================================
//  Compares the org to a snapshot's Id manifest and removes records that didn't
//  exist at snapshot time: all post-snapshot Agent_Action_Log__c rows, and all
//  post-snapshot Cases with Correlation_Id__c LIKE 'ITF-%' (the simulator's).
//  Seeded demo data (present in the snapshot) is left untouched.
//
//  Dry run (default):  node --env-file=.env scripts/reset.mjs
//  Apply:              node --env-file=.env scripts/reset.mjs --apply
//  Specific snapshot:  node --env-file=.env scripts/reset.mjs <snapshot-dir> --apply
// ============================================================================

import { query, deleteRecord } from "../server/salesforce.js";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const apply = args.includes("--apply");
let snapArg = args.find((a) => !a.startsWith("--"));

const snapsRoot = join(ROOT, "snapshots");
let snapDir;
if (!snapArg) {
  const dirs = (await readdir(snapsRoot)).filter((d) => !d.startsWith(".")).sort();
  if (!dirs.length) {
    console.error("No snapshots found — run scripts/snapshot.mjs first.");
    process.exit(1);
  }
  snapDir = join(snapsRoot, dirs[dirs.length - 1]);
} else {
  snapDir = snapArg.includes("/") ? snapArg : join(snapsRoot, snapArg);
}

const manifest = JSON.parse(await readFile(join(snapDir, "_manifest.json"), "utf8"));
console.log(`Snapshot: ${snapDir}\nTaken at: ${manifest.takenAt}\n`);

const snapIds = (obj) => new Set((manifest.objects[obj] && manifest.objects[obj].ids) || []);

async function junkNotInSnapshot(obj, soql) {
  const snap = snapIds(obj);
  const r = await query(soql);
  return r.records.filter((x) => !snap.has(x.Id));
}

// Children first (logs), then parents (cases).
const junkLogs = await junkNotInSnapshot("Agent_Action_Log__c", "SELECT Id FROM Agent_Action_Log__c LIMIT 2000");
const junkCases = await junkNotInSnapshot(
  "Case",
  "SELECT Id, CaseNumber, Correlation_Id__c FROM Case WHERE Correlation_Id__c LIKE 'ITF-%' LIMIT 2000",
);

console.log(`Would delete ${junkLogs.length} Agent_Action_Log__c row(s) and ${junkCases.length} ITF- Case(s):`);
for (const c of junkCases) console.log(`  Case ${c.CaseNumber}  ${c.Correlation_Id__c}  ${c.Id}`);

if (!apply) {
  console.log("\nDry run — re-run with --apply to delete.");
  process.exit(0);
}

let n = 0;
for (const r of junkLogs) {
  try {
    await deleteRecord("Agent_Action_Log__c", r.Id);
    n++;
  } catch (e) {
    console.log("  log delete error:", e.message);
  }
}
for (const c of junkCases) {
  try {
    await deleteRecord("Case", c.Id);
    n++;
  } catch (e) {
    console.log(`  case ${c.CaseNumber} delete error:`, e.message);
  }
}
console.log(`\nDeleted ${n} record(s). Org reset to the snapshot's demo-data state.`);
