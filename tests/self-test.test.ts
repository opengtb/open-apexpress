import { expect, test } from "bun:test";
import { selfTest } from "../src/self-test";

// The Windows CI runs this on the built executable: it must pass with every recipe of the catalog,
// including the ones whose parameters are required.
test("self-test of the executable passes", async () => {
  expect(await selfTest()).toBe(true);
}, 60_000);
