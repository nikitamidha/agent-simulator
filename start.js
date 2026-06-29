// ============================================================================
//  LAUNCHER  —  spawns BOTH the API server and the client server.
//  Run with:  npm start   (or: node start.js)
// ============================================================================

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const children = [];
let shuttingDown = false;

function prefixLines(prefix, buf) {
  return buf
    .toString()
    .split("\n")
    .filter((l) => l.length)
    .map((l) => `${prefix} ${l}`)
    .join("\n") + "\n";
}

function run(name, relFile, color) {
  const prefix = `${color}[${name}]\x1b[0m`;
  const child = spawn(process.execPath, [join(__dirname, relFile)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  child.stdout.on("data", (d) => process.stdout.write(prefixLines(prefix, d)));
  child.stderr.on("data", (d) => process.stderr.write(prefixLines(prefix, d)));
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.log(`${prefix} exited with code ${code} — shutting down.`);
      shutdown();
    }
  });
  children.push(child);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Starting Agent Simulator…");
run("api", "server/index.js", "\x1b[36m"); // cyan
run("client", "client/server.js", "\x1b[35m"); // magenta
console.log("Open the UI at \x1b[1mhttp://localhost:3000\x1b[0m\n");
