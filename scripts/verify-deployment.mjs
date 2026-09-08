/**
 * The live half of drift detection.
 *
 * The gate compares the generated workflow against a RECORDED export. That
 * establishes the generator has not changed since the baseline was taken; it
 * establishes nothing about what is running in the instance right now. Codex
 * was explicit when the local half was written, and the debt stayed open for
 * exactly this:
 *
 *   "The new gate verifies a normalized structural fixture against current
 *    generated code, not the deployed workflow."
 *
 * So this uploads nothing and changes nothing. It finds the workflow already
 * deployed, exports it, and compares. A run that would have to deploy in order
 * to check has not checked anything — it has replaced the thing it was meant to
 * inspect.
 *
 * Three outcomes, as everywhere:
 *   0  the deployment matches what this repository generates
 *   1  it differs, and the differing paths are printed
 *   2  it could not be established — no key, no network, nothing deployed
 *
 * Not part of the gate: a check that needs the network fails for reasons that
 * have nothing to do with the code, and a gate that fails for unrelated reasons
 * is a gate people learn to ignore.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { generate } from "./generate-workflow.mjs";
import { compareWorkflows } from "./drift.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const API = process.env.N8N_API_URL;
const KEY = process.env.N8N_API_KEY;

/**
 * Find the deployed workflow.
 *
 * By id when one is configured, because a name is editable in the UI: Codex,
 * chunk 2 debt — renaming the live workflow made this report "nothing deployed"
 * and exit 2, so a rename would hide drift behind could-not-establish. An id is
 * assigned by the instance and does not change.
 *
 * The name is still checked when an id is given, and a mismatch is reported
 * rather than ignored: the id points at the right record, but a workflow that
 * has been renamed is a deployment somebody changed, and that is worth saying.
 *
 * Without an id it falls back to the name, and says so, because a fallback that
 * looks like the real thing is how a weaker check gets mistaken for the strong one.
 */
export function pickDeployed(list, name, configuredId) {
  /*
   * A listing that could not be READ is not an empty instance.
   *
   * This was `list ?? []`, so `undefined` and `[]` produced the identical
   * `absent` — and `absent` is a positive claim about the instance: nothing of
   * this name is deployed. The test written for the distinction asserted the
   * collapse, in its own words: "A listing that could not be read must not
   * resolve to 'nothing deployed'" — and then expected exactly that. A subagent
   * found the pair on 2026-09-07.
   *
   * `unreadable` is its own state, so a caller can tell "I looked and there is
   * nothing" from "I could not look". The three-states rule this project
   * applies everywhere else, applied here.
   */
  if (!Array.isArray(list)) {
    return { state: "unreadable", by: configuredId ? "id" : "name",
      reason: `the workflow listing was ${list === undefined ? "not returned" : JSON.stringify(list)}, `
        + "so whether anything is deployed is unestablished" };
  }
  const all = list;

  if (configuredId !== undefined && configuredId !== null && configuredId !== "") {
    const byId = all.find((w) => w.id === configuredId);
    if (byId === undefined) return { state: "absent", by: "id", reason: `no workflow with id ${configuredId}` };
    if (byId.name !== name) return { state: "renamed", id: byId.id, deployedName: byId.name, expectedName: name };
    return { state: "found", id: byId.id, by: "id" };
  }

  const matches = all.filter((w) => w.name === name);
  if (matches.length === 0) return { state: "absent", by: "name" };
  if (matches.length > 1) return { state: "ambiguous", ids: matches.map((w) => w.id) };
  return { state: "found", id: matches[0].id, by: "name" };
}

async function main() {
  if (!API || !KEY) {
    process.stdout.write("unchecked: N8N_API_URL and N8N_API_KEY are not set; source ~/.config/ai-sre/n8n.env\n");
    process.exit(2);
  }

  const { workflow } = await generate();
  const headers = { "X-N8N-API-KEY": KEY };

  const configuredId = process.env.N8N_WORKFLOW_ID;
  let picked;

  if (configuredId) {
    // Codex, chunk 2 debt: this used to list workflows and search the result.
    // The listing is paginated, so a configured workflow beyond the first page
    // was reported absent — a deployment hidden behind could-not-establish for
    // no reason but its position in a list. An id is fetched directly.
    try {
      const res = await fetch(`${API}/workflows/${configuredId}`, { headers });
      if (res.status === 404) {
        process.stdout.write(`unchecked: no workflow with id ${configuredId}. This says nothing about drift — it says nothing is there to compare.\n`);
        process.exit(2);
      }
      if (!res.ok) {
        process.stdout.write(`unchecked: fetching ${configuredId} returned HTTP ${res.status}\n`);
        process.exit(2);
      }
      const one = await res.json();
      picked = one.name === workflow.name
        ? { state: "found", id: one.id, by: "id" }
        : { state: "renamed", id: one.id, deployedName: one.name, expectedName: workflow.name };
    } catch (e) {
      process.stdout.write(`unchecked: could not reach the instance: ${e && e.message}\n`);
      process.exit(2);
    }
  } else {
    let list;
    try {
      const res = await fetch(`${API}/workflows`, { headers });
      if (!res.ok) {
        process.stdout.write(`unchecked: listing workflows returned HTTP ${res.status}\n`);
        process.exit(2);
      }
      list = (await res.json()).data;
    } catch (e) {
      // A network failure is not a clean deployment and not a dirty one.
      process.stdout.write(`unchecked: could not reach the instance: ${e && e.message}\n`);
      process.exit(2);
    }
    picked = pickDeployed(list, workflow.name);
  }
  if (picked.state === "unreadable") {
    // Exit 2, and the sentence says what it is: I could not look. The `absent`
    // branch below makes a positive claim about the instance, and this is not
    // that claim.
    process.stdout.write(`unchecked: ${picked.reason}\n`);
    process.exit(2);
  }
  if (picked.state === "absent") {
    const how = picked.by === "id" ? picked.reason : `no workflow named ${JSON.stringify(workflow.name)} is deployed`;
    process.stdout.write(`unchecked: ${how}. This says nothing about drift — it says nothing is there to compare.\n`);
    process.exit(2);
  }
  if (picked.state === "renamed") {
    // The id found it, so this is not could-not-establish: it is a deployment
    // that somebody changed, and a changed deployment is exactly the finding.
    process.stdout.write(`drifted: workflow ${picked.id} is deployed as ${JSON.stringify(picked.deployedName)}, not ${JSON.stringify(picked.expectedName)}\n`);
    process.exit(1);
  }
  if (picked.by === "name") {
    process.stdout.write(`note: matched by name. Set N8N_WORKFLOW_ID to match by id, which a UI rename cannot break.\n`);
  }
  if (picked.state === "ambiguous") {
    // Two workflows with one name is itself a deployment problem: nobody can
    // say which one serves traffic, so no comparison would mean anything.
    process.stdout.write(`drifted: ${picked.ids.length} workflows share the name ${JSON.stringify(workflow.name)} (${picked.ids.join(", ")})\n`);
    process.exit(1);
  }

  let deployed;
  try {
    const res = await fetch(`${API}/workflows/${picked.id}`, { headers });
    if (!res.ok) {
      process.stdout.write(`unchecked: exporting ${picked.id} returned HTTP ${res.status}\n`);
      process.exit(2);
    }
    deployed = await res.json();
  } catch (e) {
    process.stdout.write(`unchecked: could not export ${picked.id}: ${e && e.message}\n`);
    process.exit(2);
  }

  const r = compareWorkflows(workflow, deployed);
  if (r.state === "same") {
    process.stdout.write(`same: deployment ${picked.id} matches what this repository generates\n`);
    process.exit(0);
  }
  if (r.state === "unchecked") {
    process.stdout.write(`unchecked: ${r.reason}\n`);
    process.exit(2);
  }
  process.stdout.write(
    `drifted: deployment ${picked.id} differs at ${r.differences.length} path(s)\n` +
      r.differences.slice(0, 10).map((d) => `  ${d.path}\n    generated: ${d.generated}\n    deployed:  ${d.deployed}\n`).join(""),
  );
  process.exit(1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    process.stdout.write(`unchecked: ${e && e.message}\n`);
    process.exit(2);
  });
}
