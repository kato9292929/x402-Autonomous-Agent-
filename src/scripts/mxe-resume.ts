/**
 * Resumes MXE functions the breaker paused (src/mxe/breaker.ts).
 *
 *   npm run mxe:resume -- 1        resume function 1
 *   npm run mxe:resume -- all      resume every function
 *   npm run mxe:resume             show what is paused
 *
 * Runs before the resume time no longer count, so a resumed function gets
 * three fresh run days before the breaker can pause it again.
 */
import { loadBreaker, resume } from "../mxe/breaker";
import type { MxeFunction } from "../mxe/record";

async function main() {
  const arg = process.argv[2];
  const state = await loadBreaker();
  if (!arg) {
    for (const fn of [1, 2, 3, 4, 5]) {
      const s = state[fn];
      console.log(`function ${fn}: ${s?.paused ? `paused since ${s.paused.at} — ${s.paused.reason}` : "running"}${s?.resumedAt ? ` (resumed ${s.resumedAt})` : ""}`);
    }
    return;
  }
  const fns: MxeFunction[] = arg === "all" ? [1, 2, 3, 4, 5] : [Number(arg) as MxeFunction];
  if (fns.some((f) => ![1, 2, 3, 4, 5].includes(f))) throw new Error(`usage: mxe:resume -- <1-5|all> (got ${arg})`);
  for (const fn of fns) {
    await resume(fn);
    console.log(`function ${fn}: resumed`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
