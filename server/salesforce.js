// ============================================================================
//  SALESFORCE CLIENT  —  real read/write access to your org (REST)
// ============================================================================
//
//  All DATA calls are the Salesforce REST API. Authentication modes, in
//  priority order:
//
//   1. OAuth username-password (REST) — if SF_CLIENT_ID + SF_CLIENT_SECRET are
//      set. One POST /services/oauth2/token (grant_type=password). Needs a
//      Connected App and the org setting "Allow OAuth Username-Password Flows".
//      CLI-independent.
//
//   2. CLI session (reuse `sf`) — DEFAULT when SF_USERNAME is set. We ask the
//      Salesforce CLI for a usable token via `sf org display --json` (the CLI
//      decrypts + refreshes it for us — the tokens in ~/.sfdx are ENCRYPTED, so
//      they can't be read directly). Re-runs on a 401. Requires the `sf` CLI to
//      be installed and the org authorized (`sf org login web`).
//
//   3. SOAP login — fallback; disabled on many orgs.
//
//  Only Node built-ins (fetch, child_process).
// ============================================================================

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const USERNAME = process.env.SF_USERNAME;
const PASSWORD = process.env.SF_PASSWORD;
const TOKEN = process.env.SF_SECURITY_TOKEN || "";
const LOGIN_URL = process.env.SF_LOGIN_URL || "https://login.salesforce.com";
const API_VERSION = process.env.SF_API_VERSION || "60.0";
const CLI_ORG = process.env.SF_CLI_ORG || USERNAME; // alias or username for `sf`
const CLIENT_ID = process.env.SF_CLIENT_ID;
const CLIENT_SECRET = process.env.SF_CLIENT_SECRET;

function authMode() {
  if (CLIENT_ID && CLIENT_SECRET && USERNAME && PASSWORD) return "oauth-password";
  if (CLI_ORG) return "cli";
  if (USERNAME && PASSWORD) return "soap";
  return null;
}

export function isConfigured() {
  return authMode() !== null;
}

let session = null; // { accessToken, instanceUrl } — in-memory only

// --- 1. OAuth username-password flow (pure REST) ----------------------------
async function passwordOAuthLogin() {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    username: USERNAME,
    password: PASSWORD + TOKEN,
  });
  const res = await fetch(`${LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(`Salesforce OAuth (password) failed: ${data.error || res.status} ${data.error_description || ""}`.trim());
  session = { accessToken: data.access_token, instanceUrl: data.instance_url };
  return session;
}

// --- 2. CLI session reuse -------------------------------------------------
// Modern `sf` redacts tokens in `org display` (even with --verbose); the real
// token comes from `sf org auth show-access-token`. The CLI handles decryption
// and refresh, so this returns a live token tied to your `sf org login` session.
async function sfJson(args) {
  let stdout;
  try {
    ({ stdout } = await execFileP("sf", args, { maxBuffer: 8 * 1024 * 1024 }));
  } catch (e) {
    if (e.stdout) stdout = e.stdout; // `sf` prints JSON even on non-zero exit
    else if (e.code === "ENOENT")
      throw new Error("Salesforce CLI `sf` not found on PATH — install it or set SF_CLIENT_ID/SECRET for OAuth.");
    else throw new Error(`sf ${args.join(" ")} failed: ${e.message}`);
  }
  return JSON.parse(stdout);
}

async function cliLogin() {
  const tokRes = await sfJson(["org", "auth", "show-access-token", "--target-org", CLI_ORG, "--json"]);
  const accessToken = tokRes.result && tokRes.result.accessToken;
  if (!accessToken)
    throw new Error(
      `Could not get an access token from the CLI (${tokRes.message || "status " + tokRes.status}) — try: sf org login web --alias ${CLI_ORG}`,
    );

  // instanceUrl is not redacted in `org display`; fall back to SF_LOGIN_URL.
  let instanceUrl = LOGIN_URL;
  try {
    const disp = await sfJson(["org", "display", "--target-org", CLI_ORG, "--json"]);
    if (disp.result && disp.result.instanceUrl) instanceUrl = disp.result.instanceUrl;
  } catch {
    /* keep SF_LOGIN_URL */
  }

  session = { accessToken, instanceUrl };
  return session;
}

// --- 3. SOAP fallback -------------------------------------------------------
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
async function soapLogin() {
  const body =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<env:Body><n1:login xmlns:n1="urn:partner.soap.sforce.com">` +
    `<n1:username>${xmlEscape(USERNAME)}</n1:username>` +
    `<n1:password>${xmlEscape(PASSWORD + TOKEN)}</n1:password>` +
    `</n1:login></env:Body></env:Envelope>`;
  const res = await fetch(`${LOGIN_URL}/services/Soap/u/${API_VERSION}`, {
    method: "POST",
    headers: { "content-type": "text/xml; charset=UTF-8", SOAPAction: "login" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    const fault = (text.match(/<faultstring>([\s\S]*?)<\/faultstring>/) || [])[1];
    throw new Error(`Salesforce SOAP login failed: ${fault || res.status}`);
  }
  const sessionId = (text.match(/<sessionId>([\s\S]*?)<\/sessionId>/) || [])[1];
  const serverUrl = (text.match(/<serverUrl>([\s\S]*?)<\/serverUrl>/) || [])[1];
  if (!sessionId || !serverUrl) throw new Error("Salesforce SOAP login: could not parse session");
  session = { accessToken: sessionId, instanceUrl: new URL(serverUrl).origin };
  return session;
}

async function login() {
  const mode = authMode();
  if (mode === "oauth-password") return passwordOAuthLogin();
  if (mode === "cli") return cliLogin();
  if (mode === "soap") return soapLogin();
  throw new Error("Salesforce not configured (set SF_USERNAME for CLI auth, or SF_CLIENT_ID/SECRET for OAuth).");
}

async function ensureSession() {
  return session || login();
}

// --- REST caller (re-auth + retry once on 401) ------------------------------
async function rest(method, path, jsonBody, _retried = false) {
  const s = await ensureSession();
  const res = await fetch(`${s.instanceUrl}/services/data/v${API_VERSION}${path}`, {
    method,
    headers: { authorization: `Bearer ${s.accessToken}`, "content-type": "application/json" },
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
  });

  if (res.status === 401 && !_retried) {
    session = null;
    await login();
    return rest(method, path, jsonBody, true);
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = Array.isArray(data) ? data.map((e) => e.message).join("; ") : data.message || res.status;
    throw new Error(`Salesforce ${method} ${path} failed: ${msg}`);
  }
  return data;
}

// --- Public API -------------------------------------------------------------
export async function query(soql) {
  return rest("GET", `/query?q=${encodeURIComponent(soql)}`);
}
export async function createRecord(sobject, fields) {
  return rest("POST", `/sobjects/${encodeURIComponent(sobject)}`, fields);
}
export async function updateRecord(sobject, id, fields) {
  await rest("PATCH", `/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`, fields);
  return { id, success: true };
}
export async function deleteRecord(sobject, id) {
  await rest("DELETE", `/sobjects/${encodeURIComponent(sobject)}/${encodeURIComponent(id)}`);
  return { id, success: true };
}
export async function ping() {
  await rest("GET", "/limits"); // real call so health reflects reality
  return { ok: true, instanceUrl: session.instanceUrl, authMode: authMode() };
}

// Post a TextPost to the Chatter feed of a record (e.g. a Case).
export async function postToFeed(parentId, body) {
  return rest("POST", "/sobjects/FeedItem", { ParentId: parentId, Type: "TextPost", Body: body });
}

// Run an anonymous Apex file via the CLI (used by "Reset Org to Demo Data").
export async function runApex(filePath) {
  let stdout;
  try {
    ({ stdout } = await execFileP("sf", ["apex", "run", "--file", filePath, "--target-org", CLI_ORG, "--json"], {
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (e) {
    if (e.stdout) stdout = e.stdout; // `sf` prints JSON even on non-zero exit
    else if (e.code === "ENOENT") throw new Error("Salesforce CLI `sf` not found on PATH.");
    else throw new Error(`sf apex run failed: ${e.message}`);
  }
  const r = (JSON.parse(stdout) || {}).result || {};
  if (r.compiled === false) throw new Error(`Apex compile error: ${r.compileProblem || "unknown"}`);
  if (r.success === false) throw new Error(`Apex run error: ${r.exceptionMessage || "unknown"}`);
  return { success: true };
}
