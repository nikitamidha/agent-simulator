// ============================================================================
//  snapshot.mjs — point-in-time backup of the Salesforce demo data
// ============================================================================
//  Dumps the demo-relevant objects to snapshots/<timestamp>/ as JSON, plus a
//  _manifest.json listing the record Ids that existed at snapshot time. The
//  manifest lets a future reset/cleanup delete only records created AFTER the
//  snapshot (the test junk), without touching the seeded demo data.
//
//  Run:  node --env-file=.env scripts/snapshot.mjs
// ============================================================================

import { query } from "../server/salesforce.js";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OBJECTS = [
  "Account",
  "Contact",
  "Case",
  "Asset",
  "Telemetry_Reading__c",
  "Runbook__c",
  "Agent_Action_Log__c",
  "Eval_Result__c",
];

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(ROOT, "snapshots", ts);
await mkdir(dir, { recursive: true });

const manifest = { takenAt: new Date().toISOString(), objects: {} };
for (const obj of OBJECTS) {
  try {
    const r = await query(`SELECT FIELDS(ALL) FROM ${obj} LIMIT 200`);
    await writeFile(join(dir, `${obj}.json`), JSON.stringify(r.records, null, 2));
    manifest.objects[obj] = { count: r.totalSize, ids: r.records.map((x) => x.Id) };
    console.log(`${obj}: ${r.totalSize}`);
  } catch (e) {
    manifest.objects[obj] = { error: String(e.message) };
    console.log(`${obj}: ERROR ${e.message}`);
  }
}
await writeFile(join(dir, "_manifest.json"), JSON.stringify(manifest, null, 2));
console.log("\nSnapshot written to:", dir);
