import { expect, test } from "@playwright/test";

test("app boots, renders 4 steps + log panel, degrades gracefully with no wallet", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/");

  // Title + header render (proves the WASM-backed SDK bundle initialised).
  await expect(page.getByRole("heading", { name: /Lace in-wallet proving PoC/i })).toBeVisible();

  // All four steps present.
  await expect(page.getByText("Connect wallet")).toBeVisible();
  await expect(page.getByText("Deploy test contract")).toBeVisible();
  await expect(page.getByText("Generate proof + call increment")).toBeVisible();
  await expect(page.getByText(/Show results/i)).toBeVisible();

  // Log panel booted.
  await expect(page.getByText("Event log")).toBeVisible();
  await expect(page.getByText(/PoC booted/i)).toBeVisible();

  // No wallet headless: detection reports "none".
  await expect(page.getByText(/wallets injected/i)).toBeVisible();

  // Clicking Connect must NOT crash — it should log a clean error and set the
  // step to "error", which is the expected headless outcome.
  await page.getByRole("button", { name: /Connect Lace/i }).click();
  await expect(page.getByText(/No Midnight wallet injected under window\.midnight|not present/i).first()).toBeVisible({
    timeout: 15_000,
  });

  // React must not have thrown an uncaught render error.
  expect(pageErrors, `page errors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});
