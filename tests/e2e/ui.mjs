// End-to-end UI scenario in a real browser, against the demo APEX.
// Usage: node ui.mjs <app url with token> <screenshot dir>
import { chromium } from "playwright";

const [, , url, out = "."] = process.argv;
const browser = await chromium.launch();
const errors = [];
async function scenario(lang, theme) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: theme, locale: lang === "fr" ? "fr-FR" : "en-US" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${lang}/${theme} pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${lang}/${theme} console: ${m.text()}`));
  const shot = (name) => page.screenshot({ path: `${out}/${lang}-${theme}-${name}.png`, fullPage: false });
  await page.goto(url);
  await page.evaluate(([l, t]) => { localStorage.setItem("apexpress-lang", l); localStorage.setItem("apexpress-theme", t); }, [lang, theme]);
  await page.reload();
  await page.waitForSelector(".connect-card");
  await shot("1-connect");
  await page.click(".connect-card .btn-ghost");
  await page.waitForSelector(".recipes");
  await page.click(".pack >> nth=0"); // Zigbee pack
  await page.click(".recipe:has(b:text-is('Grafana'))");
  await page.waitForTimeout(300);
  await shot("2-catalog");
  await page.click(".sticky-bar .btn-primary");
  await page.waitForSelector(".recipe-form");
  await page.waitForSelector(".plan-list");
  await page.waitForTimeout(600);
  await shot("3-settings-missing");
  await page.fill("#p-zigbee2mqtt-coordinatorHost", "192.168.1.11");
  await page.waitForFunction(() => !document.querySelector(".settings-side .btn-primary")?.hasAttribute("disabled"), null, { timeout: 10000 });
  await page.waitForTimeout(400);
  await shot("4-settings-ready");
  await page.click(".settings-side .btn-primary");
  await page.waitForSelector(".install");
  await page.waitForTimeout(4000);
  await shot("5-installing");
  await page.waitForSelector(".services", { timeout: 120000 });
  await page.waitForTimeout(500);
  await shot("6-done");
  const title = await page.textContent(".install-title h2");
  if (!/terminée|complete/i.test(title)) errors.push(`${lang}/${theme}: unexpected result "${title}"`);
  await page.screenshot({ path: `${out}/${lang}-${theme}-6-done-full.png`, fullPage: true });
  await page.click(".tab >> nth=1");
  await page.waitForSelector(".table");
  await shot("7-apex");
  await page.click(".tab >> nth=2");
  await page.waitForSelector(".tool");
  await page.fill(".tool >> nth=0 >> input", "influxdb:2.7");
  await page.click(".tool >> nth=0 >> .btn-primary");
  await page.locator(".tool").first().locator(".alert").waitFor({ timeout: 60000 });
  const arm = await page.locator(".tool").first().locator(".alert").textContent();
  if (!/Compatible/i.test(arm)) errors.push(`${lang}/${theme}: ARM64 test result "${arm}"`);
  await shot("8-tools");
  await page.click(".tab >> nth=3");
  await page.waitForSelector(".exchanges");
  await shot("9-journal");
  await page.click(".topbar [title*='connect']");
  await ctx.close();
}
await scenario("fr", "light");
await scenario("en", "dark");
await browser.close();
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "UI E2E OK");
process.exit(errors.length ? 1 : 0);
