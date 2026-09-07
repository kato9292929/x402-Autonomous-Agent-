/**
 * Weekly external x402 probe.
 *
 * Calls five third-party sellers once a week to measure what they actually
 * return and what they actually charge. This is the first spend that leaves our
 * own economy, so the measurement is the point: quoted price vs real charge,
 * latency, and whether the payload is usable by osd / JIN.
 *
 * Two modes:
 *   discovery ("run 0") — pays nothing. Checks reachability, reads each seller's
 *     free metadata routes, and sends one unpaid request per known route to read
 *     the 402 and its price. Nothing here can spend money: it uses plain fetch,
 *     never the paying client. This is the gate — the sweep is not run until a
 *     discovery report exists.
 *   sweep — the paid weekly run. Every payment goes through the probe client,
 *     whose policy refuses anything above the per-call / per-run / per-week
 *     ceilings during requirement selection, i.e. before signing.
 *
 * Read-only: routes that look like execution (/swap, /trade, …) are never
 * called, for any seller.
 */
import { decodePaymentResponseHeader } from "@x402/fetch";
import { x402Client } from "@x402/fetch";
import { x402HTTPClient } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { PROBE_TARGETS, isExecutionPath, type ProbeTarget, type ProbePath } from "../probe/targets";
import {
  buildProbeClient,
  capsSummary,
  observe,
  PROBE_NETWORKS,
  type ObservedChallenge,
  type ProbeClient,
  type ProbeSpend,
} from "../probe/client";
import {
  allowsCall,
  isoWeekKey,
  readWeekSpend,
  recordWeekSpend,
  PER_RUN_CAP_USD,
  WEEKLY_CAP_USD,
} from "../probe/budget";
import {
  appendCsv,
  summarize,
  summarizeBody,
  type ProbeCallRecord,
  type TargetSummary,
} from "../probe/record";
import { priceOf } from "../payment-guard";

/** Consecutive failures from one seller before it is dropped for the day (§2). */
const MAX_CONSECUTIVE_ERRORS = 3;

/**
 * Timeout for discovery requests. Applied to run 0 only: those are unpaid, so
 * an abort costs nothing. A paid request is deliberately left to run — aborting
 * after the payment is signed would spend the money and discard the response.
 */
const DISCOVERY_TIMEOUT_MS = 15_000;

export interface ProbeRunOptions {
  mode: "discovery" | "sweep";
  targets?: ProbeTarget[];
  /** Unpaid fetch. Injected in tests. */
  fetchImpl?: typeof globalThis.fetch;
  /** Paying client. Injected in tests; built from env otherwise. */
  client?: ProbeClient | null;
  /** Already spent this ISO week. Read from the persistent store otherwise. */
  weekSpentUsdc?: number;
  /** Append to the CSV. Off in tests. */
  write?: boolean;
}

export interface ProbeRunReport {
  mode: "discovery" | "sweep";
  week: string;
  records: ProbeCallRecord[];
  summaries: TargetSummary[];
  runSpentUsdc: number;
  weekSpentUsdc: number;
}

/** Parses a 402 with the official reader — v2 header and v1 body both. */
const reader = new x402HTTPClient(new x402Client());

function readChallenge(res: Response, body: unknown): ObservedChallenge | undefined {
  try {
    const pr = reader.getPaymentRequiredResponse((n) => res.headers.get(n), body);
    return observe(pr);
  } catch {
    return undefined;
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function url(target: ProbeTarget, p: string): string {
  return `${target.host.replace(/\/$/, "")}${p}`;
}

// ── discovery (run 0) ───────────────────────────────────────────────────────

async function discoverPath(
  target: ProbeTarget,
  p: string,
  method: "GET" | "POST",
  body: Record<string, unknown> | undefined,
  doFetch: typeof globalThis.fetch
): Promise<ProbeCallRecord> {
  const at = new Date().toISOString();
  const startMs = Date.now();
  const base: ProbeCallRecord = {
    at,
    target: target.id,
    path: p,
    method,
    latencyMs: 0,
    outcome: "error",
  };

  try {
    const res = await doFetch(url(target, p), {
      method,
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const payload = await readBody(res);
    base.latencyMs = Date.now() - startMs;
    base.httpStatus = res.status;

    if (res.status === 402) {
      const challenge = readChallenge(res, payload);
      if (!challenge) {
        return { ...base, outcome: "error", reason: "402 だが PAYMENT-REQUIRED を読めない" };
      }
      const quoted = challenge.quotedUsdc;
      const verdict = quoted !== undefined ? allowsCall(quoted, 0, 0) : undefined;
      const reason =
        quoted === undefined
          ? `対応チェーンなし(offered: ${challenge.offeredNetworks.join(" ") || "?"})`
          : verdict?.allowed
            ? "run0: 402 読み取り成功・予算内(無課金)"
            : `run0: 単価が上限超過のため本番でも叩かない — ${verdict?.reason}`;
      return {
        ...base,
        outcome: "skipped",
        quotedUsdc: quoted,
        offeredNetworks: challenge.offeredNetworks,
        reason,
      };
    }

    if (res.ok) {
      return { ...base, outcome: "free", summary: summarizeBody(payload), reason: "無課金で 200" };
    }
    return {
      ...base,
      outcome: "error",
      reason: `HTTP ${res.status}`,
      summary: summarizeBody(payload),
    };
  } catch (err) {
    return {
      ...base,
      latencyMs: Date.now() - startMs,
      outcome: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runDiscovery(
  targets: ProbeTarget[],
  doFetch: typeof globalThis.fetch
): Promise<ProbeCallRecord[]> {
  const records: ProbeCallRecord[] = [];
  for (const target of targets) {
    console.log(`[PROBE] run0 ${target.name} (${target.host})`);
    for (const meta of target.metadata) {
      records.push(await discoverPath(target, meta, "GET", undefined, doFetch));
    }
    for (const probe of target.probes) {
      if (isExecutionPath(probe.path)) continue; // 執行系は discovery でも叩かない
      records.push(await discoverPath(target, probe.path, probe.method, probe.body, doFetch));
    }
    if (target.probes.length === 0) {
      console.log(
        `[PROBE] ${target.name}: 有料ルート未確定 — metadata の結果からルートを決めてから sweep 対象にする`
      );
    }
  }
  return records;
}

// ── sweep (paid) ────────────────────────────────────────────────────────────

/** The price of the requirement that actually settled, when it can be read. */
function settledPrice(
  challenge: ObservedChallenge | undefined,
  network: string,
  settledAmount?: string
): number | undefined {
  if (settledAmount !== undefined) {
    try {
      return Number(BigInt(settledAmount)) / 1e6;
    } catch {
      /* fall through to the quoted requirement */
    }
  }
  const match = (challenge?.accepts ?? []).find(
    (r: PaymentRequirements) => String((r as { network?: unknown }).network ?? "") === network
  );
  return match ? priceOf(match) : challenge?.quotedUsdc;
}

async function sweepPath(
  target: ProbeTarget,
  probe: ProbePath,
  client: ProbeClient,
  spend: ProbeSpend
): Promise<ProbeCallRecord> {
  const at = new Date().toISOString();
  const startMs = Date.now();
  const base: ProbeCallRecord = {
    at,
    target: target.id,
    path: probe.path,
    method: probe.method,
    latencyMs: 0,
    outcome: "error",
  };

  client.takeChallenge(); // 前回の残りを持ち越さない

  try {
    const res = await client.fetch(url(target, probe.path), {
      method: probe.method,
      ...(probe.body
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(probe.body) }
        : {}),
    });
    const challenge = client.takeChallenge();
    const payload = await readBody(res);
    base.latencyMs = Date.now() - startMs;
    base.httpStatus = res.status;
    base.quotedUsdc = challenge?.quotedUsdc;
    base.offeredNetworks = challenge?.offeredNetworks;

    const settleHeader =
      res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
    if (settleHeader) {
      try {
        const settle = decodePaymentResponseHeader(settleHeader);
        base.chain = String(settle.network ?? "");
        base.txHash = settle.transaction;
        base.actualUsdc = settledPrice(challenge, base.chain, settle.amount);
      } catch {
        // ヘッダはあるが読めない: 課金額は「不明」として残す(掲載価格で埋めない)
        base.reason = "PAYMENT-RESPONSE を読めない";
      }
    }

    if (!res.ok) {
      return { ...base, outcome: "error", reason: `HTTP ${res.status}`, summary: summarizeBody(payload) };
    }
    return {
      ...base,
      outcome: settleHeader ? "paid" : "free",
      summary: summarizeBody(payload),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const challenge = client.takeChallenge();
    base.latencyMs = Date.now() - startMs;
    base.quotedUsdc = challenge?.quotedUsdc;
    base.offeredNetworks = challenge?.offeredNetworks;

    // 支払わずに止まった場合を「エラー」と混ぜない。policy が要件を全部落とすと
    // ライブラリは選択段階で失敗する = 署名前に弾かれている。
    if (challenge) {
      if (challenge.quotedUsdc === undefined) {
        return {
          ...base,
          outcome: "skipped",
          reason:
            `probe ウォレットが対応しないチェーンのみ提示された` +
            ` (offered: ${challenge.offeredNetworks.join(" ") || "?"})`,
        };
      }
      const verdict = allowsCall(challenge.quotedUsdc, spend.run, spend.week);
      if (!verdict.allowed) {
        return { ...base, outcome: "skipped", reason: `予算で拒否(${verdict.ceiling}): ${verdict.reason}` };
      }
    }
    return { ...base, outcome: "error", reason: msg };
  }
}

async function runSweep(
  targets: ProbeTarget[],
  client: ProbeClient,
  spend: ProbeSpend
): Promise<ProbeCallRecord[]> {
  const records: ProbeCallRecord[] = [];

  for (const target of targets) {
    let consecutiveErrors = 0;
    const budgetedProbes = target.probes.slice(0, target.weeklyCallBudget);
    if (budgetedProbes.length === 0) {
      console.log(`[PROBE] ${target.name}: 有料ルート未確定のためスキップ(run0 待ち)`);
      continue;
    }

    for (const probe of budgetedProbes) {
      if (isExecutionPath(probe.path)) {
        // 設定ミス。叩かずに大きく記録する。
        console.error(`[PROBE] ${target.name}${probe.path} は執行系のため呼ばない`);
        records.push({
          at: new Date().toISOString(),
          target: target.id,
          path: probe.path,
          method: probe.method,
          latencyMs: 0,
          outcome: "skipped",
          reason: "執行系ルート — 読み取り専用の運用のため呼ばない",
        });
        continue;
      }
      if (spend.run >= PER_RUN_CAP_USD || spend.week >= WEEKLY_CAP_USD) {
        console.warn(
          `[PROBE] 予算到達で中断 (run $${spend.run.toFixed(4)} / week $${spend.week.toFixed(4)})`
        );
        return records;
      }

      const record = await sweepPath(target, probe, client, spend);
      records.push(record);

      if (record.outcome === "paid" && record.actualUsdc !== undefined) {
        spend.run += record.actualUsdc;
        spend.week += record.actualUsdc;
        await recordWeekSpend("probe", record.actualUsdc, { target: target.id, path: probe.path });
      }

      consecutiveErrors = record.outcome === "error" ? consecutiveErrors + 1 : 0;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.warn(`[PROBE] ${target.name}: ${MAX_CONSECUTIVE_ERRORS} 回連続エラー — 当日はスキップ`);
        break;
      }
    }
  }
  return records;
}

// ── entry point ─────────────────────────────────────────────────────────────

export async function runExternalProbe(options: ProbeRunOptions): Promise<ProbeRunReport> {
  const targets = options.targets ?? PROBE_TARGETS;
  const week = isoWeekKey();
  const weekSpentBefore = options.weekSpentUsdc ?? (await readWeekSpend("probe", week));
  const spend: ProbeSpend = { run: 0, week: weekSpentBefore };

  console.log(
    `[PROBE] ${options.mode} — ${targets.length} 先 / ${week} / 消費済み $${weekSpentBefore.toFixed(4)} / 上限 ${capsSummary()}`
  );

  let records: ProbeCallRecord[];
  if (options.mode === "discovery") {
    // 支払いクライアントには触れない。run 0 で課金が起きる余地を残さない。
    records = await runDiscovery(targets, options.fetchImpl ?? fetch);
  } else {
    const client = options.client !== undefined ? options.client : buildProbeClient(spend);
    if (!client) {
      throw new Error(
        "probe ウォレット未設定: CIRCLE_PROBE_WALLET_ID と CIRCLE_PROBE_WALLET_ADDRESS が必要 " +
          "(鍵は Circle DCW が保持。生鍵は env に置かない)"
      );
    }
    console.log(`[PROBE] paying wallet: ${client.walletAddress} (networks: ${PROBE_NETWORKS.join(", ")})`);
    records = await runSweep(targets, client, spend);
  }

  const summaries = summarize(records);
  if (options.write !== false) appendCsv(records);

  for (const s of summaries) {
    const perCall =
      s.measuredPerCallUsdc !== undefined ? `$${s.measuredPerCallUsdc.toFixed(6)}` : "—";
    console.log(
      `[PROBE] ${s.target}: ${s.calls} calls (paid ${s.paidCalls}, skip ${s.skipped}, err ${s.errors}) ` +
        `実費 $${s.totalUsdc.toFixed(6)} / 実測per-call ${perCall} / 成功率 ${(s.successRate * 100).toFixed(0)}%`
    );
  }
  console.log(
    `[PROBE] 完了 — この回 $${spend.run.toFixed(6)} / 今週 $${spend.week.toFixed(6)} (上限 $${WEEKLY_CAP_USD})`
  );

  return {
    mode: options.mode,
    week,
    records,
    summaries,
    runSpentUsdc: spend.run,
    weekSpentUsdc: spend.week,
  };
}
