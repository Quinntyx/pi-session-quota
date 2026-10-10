import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { quotaCompletions } from "../src/completions.js";
import { formatStatus } from "../src/format.js";
import type { QuotaStatus } from "../src/types.js";

const status: QuotaStatus = {
  capacity: 250, total_remaining: 12.749, all_weekly_exhausted: false,
  buckets: [
    { session: "", cap: 150, remaining: 9.161, held: 4.052, available: 5.109 },
    { session: "Mysticism", cap: 100, remaining: 3.588, held: 0, available: 3.588 },
  ],
  retry_after_seconds: 1603,
};

test("subcommand completion filters the first argument only", () => {
  assert.deepEqual(quotaCompletions("")?.map((item) => item.value), ["list", "status", "set", "clear", "clear-all", "skim"]);
  assert.deepEqual(quotaCompletions("cl")?.map((item) => item.value), ["clear", "clear-all"]);
  assert.deepEqual(quotaCompletions("  sk")?.map((item) => item.value), ["skim"]);
  assert.equal(quotaCompletions("unknown"), null);
  for (const prefix of ["set ", "set 10", "clear ", "clear session", "skim 10%", "list "])
    assert.equal(quotaCompletions(prefix), null);
});

test("list renders a padded Unicode table with aligned numeric columns", () => {
  const output = formatStatus(status);
  const lines = output.split("\n");
  const table = lines.filter((line) => /^[┌├└│]/u.test(line));
  assert.equal(table.length, 6);
  assert.ok(table[0].startsWith("┌") && table[0].endsWith("┐"));
  assert.ok(table[2].includes("┼"));
  assert.ok(table.at(-1)!.startsWith("└") && table.at(-1)!.endsWith("┘"));
  assert.equal(new Set(table.map(visibleWidth)).size, 1);
  assert.match(output, /│ interactive │ 150 │     9\.161 │ 4\.052 │     5\.109 │/);
  assert.match(output, /│ Mysticism   │ 100 │     3\.588 │     0 │     3\.588 │/);
  assert.ok(!table.some((line) => line.includes("|")));
  assert.match(output, /Retry after: 1603s/);
});

test("session labels align wide glyphs, emoji and combining marks safely", () => {
  const names = ["研究", "🔬 lab", "Cafe\u0301", "a much longer session name", "\u001b[31mred\u001b[0m\nname"];
  const output = formatStatus({ ...status, buckets: names.map((session) => ({ ...status.buckets[1], session })) });
  const table = output.split("\n").filter((line) => /^[┌├└│]/u.test(line));
  assert.equal(table.length, names.length + 4);
  assert.equal(new Set(table.map(visibleWidth)).size, 1);
  assert.ok(!output.includes("\u001b"));
  assert.match(output, /red name/);
});

test("empty list remains readable", () => {
  assert.match(formatStatus({ ...status, buckets: [] }), /No session caps/);
});
