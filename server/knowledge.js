// ============================================================================
//  KNOWLEDGE BASE / RAG  —  retrieves from the TechGuard markdown knowledge base
// ============================================================================
//
//  This is the retrieval half of "RAG" for the simulator. It:
//    1. Loads every .md file under the knowledge base directory,
//    2. Splits each file into heading-scoped chunks (one per H2/H3 section),
//    3. Indexes them with a small in-memory BM25 ranker, and
//    4. Exposes retrieve(query) so the chat loop can pull the most relevant
//       sections into the agent's system prompt each turn.
//
//  It is deliberately dependency-free (no embeddings service, no vector DB) so
//  the simulator keeps running with zero setup, exactly like the rest of the app.
//  BM25 over heading chunks is more than enough for a demo corpus this size, and
//  it works offline (mock mode) as well as with a real model.
//
//  Point it at a different corpus with AGENT_SIM_KB_DIR. By default it reads the
//  repo's knowledge/techguard/ folder (resolved relative to this file).
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const KB_ROOT = process.env.AGENT_SIM_KB_DIR
  ? path.resolve(process.env.AGENT_SIM_KB_DIR)
  : path.resolve(__dirname, "../../knowledge/techguard");

// Common words that carry no retrieval signal. Kept small on purpose.
const STOPWORDS = new Set(
  ("a an the of to in on at for and or but is are was were be been being this that " +
    "these those it its with as by from into out up down over under not no do does " +
    "did done has have had will would can could should may might must if then else " +
    "when while what which who whom whose how why we you they i he she them his her " +
    "our your their there here than too very just also about per via vs etc")
    .split(" "),
);

// BM25 parameters (standard defaults).
const K1 = 1.5;
const B = 0.75;

function tokenize(text) {
  return (String(text).toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (t) => t.length > 1 && !STOPWORDS.has(t),
  );
}

// Recursively collect .md files under a directory.
function walkMarkdown(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // KB dir missing — handled gracefully by callers.
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMarkdown(full));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(full);
  }
  return out;
}

// Split one markdown file into heading-scoped chunks.
//  - The first H1 (`# `) becomes the document title.
//  - Each H2/H3 (`## ` / `### `) starts a new chunk; its heading text becomes
//    the chunk's breadcrumb tail. Text before the first H2 is a "(intro)" chunk.
function chunkMarkdown(relPath, raw) {
  const lines = raw.split(/\r?\n/);
  let title = relPath;
  const chunks = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    if (body) chunks.push({ heading: current.heading, body });
    current = null;
  };

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.*)$/);
    const h23 = line.match(/^#{2,3}\s+(.*)$/);
    if (h1) {
      title = h1[1].trim();
      continue;
    }
    if (h23) {
      flush();
      current = { heading: h23[1].trim(), lines: [] };
      continue;
    }
    if (!current) current = { heading: "(intro)", lines: [] };
    current.lines.push(line);
  }
  flush();

  return chunks.map((c) => ({
    source: relPath,
    title,
    heading: c.heading,
    citation: `${relPath} › ${c.heading}`,
    text: c.body,
  }));
}

// ---------------------------------------------------------------------------
//  Build the index once at module load.
// ---------------------------------------------------------------------------
function buildIndex() {
  const files = walkMarkdown(KB_ROOT);
  const chunks = [];

  for (const file of files) {
    const rel = path.relative(KB_ROOT, file).split(path.sep).join("/");
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const ch of chunkMarkdown(rel, raw)) {
      const tokens = tokenize(`${ch.title} ${ch.heading} ${ch.text}`);
      chunks.push({ ...ch, tokens, len: tokens.length });
    }
  }

  // Document frequencies + term frequencies per chunk.
  const df = new Map();
  for (const c of chunks) {
    c.tf = new Map();
    for (const tok of c.tokens) c.tf.set(tok, (c.tf.get(tok) || 0) + 1);
    for (const tok of c.tf.keys()) df.set(tok, (df.get(tok) || 0) + 1);
  }

  const N = chunks.length || 1;
  const avgdl = chunks.reduce((s, c) => s + c.len, 0) / N;

  return { files, chunks, df, N, avgdl };
}

const INDEX = buildIndex();

function idf(token) {
  const n = INDEX.df.get(token) || 0;
  // BM25 idf with +1 smoothing so it's always positive.
  return Math.log(1 + (INDEX.N - n + 0.5) / (n + 0.5));
}

// ---------------------------------------------------------------------------
//  Public API
// ---------------------------------------------------------------------------

// retrieve(query) -> ranked [{ source, title, heading, citation, text, score }]
export function retrieve(query, { k = 4, minScore = 0.1 } = {}) {
  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0 || INDEX.chunks.length === 0) return [];

  const scored = INDEX.chunks.map((c) => {
    let score = 0;
    for (const qt of qTokens) {
      const tf = c.tf.get(qt);
      if (!tf) continue;
      const denom = tf + K1 * (1 - B + B * (c.len / (INDEX.avgdl || 1)));
      score += idf(qt) * ((tf * (K1 + 1)) / denom);
    }
    return { chunk: c, score };
  });

  return scored
    .filter((s) => s.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ chunk, score }) => ({
      source: chunk.source,
      title: chunk.title,
      heading: chunk.heading,
      citation: chunk.citation,
      text: chunk.text,
      score: Number(score.toFixed(3)),
    }));
}

export function knowledgeStats() {
  return {
    ok: INDEX.chunks.length > 0,
    root: KB_ROOT,
    files: INDEX.files.length,
    chunks: INDEX.chunks.length,
  };
}
