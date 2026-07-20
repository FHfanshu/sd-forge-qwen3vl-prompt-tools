import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import registry from "../../../quality/acceptance.json" with { type: "json" };
import waivers from "../../../quality/waivers.json" with { type: "json" };

type TestBody = (args: { page: Page }, testInfo: TestInfo) => unknown | Promise<unknown>;
type Viewport = { width: number; height: number };
type Box = { x: number; y: number; width: number; height: number };
type Waiver = { test: string; owner: string; reason: string; created: string; expires: string };

const requirements = new Map(registry.requirements.map((item) => [item.id, item.revision]));

function staleMessage(reference: string): string | null {
  const match = /^(.*)@(\d+)$/.exec(reference);
  if (!match) return `invalid acceptance reference ${reference}`;
  const current = requirements.get(match[1]);
  if (current === undefined) return `unknown acceptance requirement ${reference}`;
  return current === Number(match[2]) ? null : `stale acceptance reference ${reference}; current revision is ${current}`;
}

function activeWaiver(title: string): string | null {
  const today = new Date().toISOString().slice(0, 10);
  const waiver = (waivers.waivers as Waiver[]).find((item) => item.test === `mock-host.spec.ts::${title}` && item.expires >= today);
  return waiver ? `${waiver.reason} (owner: ${waiver.owner}, expires: ${waiver.expires})` : null;
}

export function acceptanceTest(reference: string, scenarios: string, title: string, body: TestBody): void {
  const waiver = activeWaiver(title);
  if (waiver) {
    test.skip(`${title} [WAIVED: ${waiver}]`, body);
    return;
  }
  const stale = staleMessage(reference);
  if (stale && process.env.PROMPT_AGENT_TEST_MODE === "affected") {
    test.skip(`${title} [ACCEPTANCE WARNING: ${stale}]`, body);
    return;
  }
  if (stale) {
    test(`${title} [${reference}; ${scenarios}]`, async () => { throw new Error(`ACCEPTANCE STALE: ${stale}`); });
    return;
  }
  test(`${title} [${reference}; ${scenarios}]`, body);
}

export function acceptanceEvidence(_reference: string, _scenarios: string): void {
  // Static evidence for a test whose primary acceptanceTest mapping is another requirement.
}

export async function expectInsideViewport(locator: Locator, viewport: Viewport): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  return box!;
}

export async function expectFloatingInsideViewport(locator: Locator, viewport: Viewport): Promise<Box> {
  const box = await expectInsideViewport(locator, viewport);
  expect(box.width < viewport.width || box.height < viewport.height).toBe(true);
  return box;
}
