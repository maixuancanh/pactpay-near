const assert = require("node:assert/strict");
const { chromium } = require("@playwright/test");

async function main() {
  const browser = await chromium.launch({executablePath: process.env.PACTPAY_TEST_CHROMIUM});
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const fixture = {
      merchant: "merchant.testnet", terms_commitment: "a".repeat(64),
      fund_until: "1000", service_end: "2000", captured: true,
      positions: [
        {buyer: "buyer.testnet", share: "20", accepted: true, funded: true,
         dispute_until: null, allocation: ["0", "20"], claims: ["Unclaimed", "Paid"]},
        {buyer: "other.testnet", share: "20", accepted: true, funded: true,
         dispute_until: "5000", allocation: null, claims: ["Unclaimed", "Unclaimed"]},
      ],
    };
    await page.route("https://test.rpc.fastnear.com/**", async route => {
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({status: 204, headers: {
          "access-control-allow-origin": "*", "access-control-allow-headers": "content-type",
        }});
      }
      const {method, params} = route.request().postDataJSON();
      const result = method === "block" ? {header: {timestamp_nanosec: "3000000000000"}} :
        {result: [...Buffer.from(JSON.stringify(params.method_name === "get_token" ? "demo.testnet" : fixture))]};
      await route.fulfill({json: {jsonrpc: "2.0", id: "pactpay", result}, headers: {"access-control-allow-origin": "*"}});
    });
    await page.goto(process.env.PACTPAY_NEAR_WEB || "http://127.0.0.1:5178/", {waitUntil: "domcontentloaded", timeout: 20000});
    await page.getByRole("img", {name: "PactPay", exact: true}).first().waitFor();
    const artwork = page.locator(".pt-hero-characters");
    await artwork.waitFor();
    await artwork.evaluate(img => img.decode());
    await page.getByLabel("Booking ID").fill("0");
    await page.getByRole("button", {name: "Load booking"}).click();
    await page.getByText("Merchant payout 20 · Received", {exact: true}).waitFor();
    await page.getByText("Disputed · funds held", {exact: true}).waitFor();
    await page.getByLabel("Exact booking terms").fill("wrong terms");
    await page.getByRole("button", {name: "Verify terms"}).click();
    await page.getByText("These terms do not match this booking.").waitFor();
    assert.equal(await page.getByRole("button", {name: /^Claim /}).count(), 0);
    await page.setViewportSize({width: 390, height: 844});
    await page.locator(".near-booking").scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    assert.deepEqual(errors, []);
    console.log("Browser smoke passed with mocked RPC: read-only booking, payout, dispute and terms mismatch.");
  } catch (error) { console.error(await browser.contexts()[0]?.pages()[0]?.locator("body").innerText()); throw error; }
  finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
