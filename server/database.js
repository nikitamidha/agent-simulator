// ============================================================================
//  MOCK CUSTOMER DATABASE  —  *** SEED YOUR DATA HERE ***
// ============================================================================
//
//  This is the single source of truth for the mock customer records that ALL
//  agents can read. Add, remove, or edit records in the `customers` array below.
//  Each record uses the simple shape the brief asked for:
//
//      name              - the customer's name
//      deploymentSite    - where their deployment lives
//      deploymentProfile - a short description of the deployment shape
//
//  (`id` is just a stable key used by the API; everything else is yours.)
//
//  Whatever you put here is injected into every agent's system prompt as
//  read-only context (see server/index.js -> customerContext()), and is also
//  shown in the UI's "Customer DB" panel so you can see what the agent sees.
// ============================================================================

export const customers = [
  {
    id: "cust-001",
    name: "Plano West Dental Group",
    deploymentSite: "Plano West Clinic, North Texas",
    deploymentProfile:
      "CCTV: 18 cameras (C-01–C-18) on NVR-PW, C-07 = Controlled Substances Cage (compliance-critical). " +
      "Network: router NS-PW, primary + backup paths; critical apps = check-in, X-rays, payments. " +
      "Web hosting: patient site + online booking flow.",
  },
  {
    id: "cust-002",
    name: "Frisco Family Dental",
    deploymentSite: "Frisco Clinic, North Texas",
    deploymentProfile:
      "CCTV: 12 cameras on NVR-FR. Network: single circuit, no backup path (failover not available). " +
      "Web hosting: brochure site only, no booking. New client — autonomy still narrow.",
  },
  {
    id: "cust-003",
    name: "Allen Orthodontics",
    deploymentSite: "Allen Clinic, North Texas",
    deploymentProfile:
      "CCTV: 9 cameras on NVR-AL. Network: primary + backup paths. " +
      "Web hosting: high-traffic booking + payments portal (frequent deploys).",
  },
];

export function getCustomer(id) {
  return customers.find((c) => c.id === id);
}
