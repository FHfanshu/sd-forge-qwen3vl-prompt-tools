import registry from "../../quality/acceptance.json" with { type: "json" };
import waivers from "../../quality/waivers.json" with { type: "json" };
import { it } from "vitest";

type TestBody = () => unknown | Promise<unknown>;
type Waiver = { test: string; owner: string; reason: string; created: string; expires: string };

const requirements = new Map(registry.requirements.map((item) => [item.id, item.revision]));

function staleMessage(reference: string): string | null {
  const match = /^(.*)@(\d+)$/.exec(reference);
  if (!match) return `invalid acceptance reference ${reference}`;
  const current = requirements.get(match[1]);
  if (current === undefined) return `unknown acceptance requirement ${reference}`;
  return current === Number(match[2]) ? null : `stale acceptance reference ${reference}; current revision is ${current}`;
}

function activeWaiver(key: string): string | null {
  const today = new Date().toISOString().slice(0, 10);
  const title = key.split("::").at(-1);
  const waiver = (waivers.waivers as Waiver[]).find((item) => (
    (item.test === key || item.test === title || item.test.endsWith(`::${title}`)) && item.expires >= today
  ));
  return waiver ? `${waiver.reason} (owner: ${waiver.owner}, expires: ${waiver.expires})` : null;
}

export function acceptanceTest(reference: string, scenarios: string, title: string, body: TestBody): void {
  const key = `${import.meta.url.split("/").at(-1)}::${title}`;
  const waiver = activeWaiver(key);
  if (waiver) {
    it.skip(`${title} [WAIVED: ${waiver}]`, body);
    return;
  }
  const stale = staleMessage(reference);
  if (stale && process.env.PROMPT_AGENT_TEST_MODE === "affected") {
    it.skip(`${title} [ACCEPTANCE WARNING: ${stale}]`, body);
    return;
  }
  if (stale) {
    it(`${title} [${reference}; ${scenarios}]`, () => { throw new Error(`ACCEPTANCE STALE: ${stale}`); });
    return;
  }
  it(`${title} [${reference}; ${scenarios}]`, body);
}

export function acceptanceEvidence(_reference: string, _scenarios: string): void {
  // Static evidence for a test whose primary acceptanceTest mapping is another requirement.
}
