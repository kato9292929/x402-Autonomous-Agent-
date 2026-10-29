/**
 * Yield(/api/yield/scan)の実レスポンスから観測値を1行に要約する。
 *
 * 目的は本番で Yield が実データ(APY 解決・liveSources・smartMoney 実値)を返して
 * いるかを AA のラン経由で観測すること。判断には使わない(ログ出力のみ)。
 *
 * 方針: 実レスポンスに在るものだけ読む。フィールドが無ければ「なし(未存在)」と
 * 明記し、0 や実値と誤認させない(推測で埋めない)。キー名/ネストは Yield 側の形に
 * 合わせて複数候補を許容して防御的に読む。
 */

function asNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asArr(v: unknown): Record<string, unknown>[] | undefined {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : undefined;
}

function firstNum(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    const n = asNum(v);
    if (n !== undefined) return n;
  }
  return undefined;
}

export function summarizeYield(data: Record<string, unknown> | undefined | null): string {
  const head = "Yield実データ観測:";
  if (!data) return `${head} レスポンス本体なし(fullData未取得)`;

  const stats = asObj(data["stats"]);
  const pools = asArr(data["topPools"]) ?? asArr(data["pools"]);

  // apyResolved = N / M (M=対象プール総数の候補)
  const apyResolved = firstNum(stats?.["apyResolved"], data["apyResolved"]);
  const apyTotal = firstNum(
    stats?.["apyTotal"],
    stats?.["totalPools"],
    stats?.["poolCount"],
    data["totalPools"],
    pools ? pools.length : undefined
  );
  const apyStr =
    apyResolved === undefined
      ? "なし(フィールド未存在)"
      : `${apyResolved}${apyTotal !== undefined ? `/${apyTotal}` : ""}`;

  // apySource 内訳 (live / static)。stats にあれば優先、無ければ topPools を集計
  let sourceStr: string;
  const liveCount = asNum(stats?.["live"]);
  const staticCount = asNum(stats?.["static"]);
  if (liveCount !== undefined || staticCount !== undefined) {
    sourceStr = `live=${liveCount ?? 0} static=${staticCount ?? 0}`;
  } else if (pools) {
    let live = 0;
    let stat = 0;
    let other = 0;
    let present = false;
    for (const p of pools) {
      const s = typeof p["apySource"] === "string" ? (p["apySource"] as string) : undefined;
      if (s === undefined) continue;
      present = true;
      if (s === "live") live++;
      else if (s === "static") stat++;
      else other++;
    }
    sourceStr = present
      ? `live=${live} static=${stat}${other ? ` other=${other}` : ""}`
      : "apySource なし(topPools に未存在)";
  } else {
    sourceStr = "なし";
  }

  // liveSources (実接続できたソース配列)
  const liveSourcesRaw =
    (Array.isArray(data["liveSources"]) && (data["liveSources"] as unknown[])) ||
    (stats && Array.isArray(stats["liveSources"]) && (stats["liveSources"] as unknown[])) ||
    undefined;
  const liveSourcesStr = liveSourcesRaw
    ? `[${liveSourcesRaw.map((x) => String(x)).join(", ")}]`
    : "なし(フィールド未存在)";

  // smartMoney サンプル(代表プール: Kamino USDC-SOL を優先、無ければ先頭プール)
  let smStr = "なし(topPools未存在)";
  if (pools && pools.length > 0) {
    const label = (p: Record<string, unknown>): string =>
      `${String(p["protocol"] ?? p["source"] ?? p["platform"] ?? "?")}-${String(
        p["pair"] ?? p["name"] ?? p["symbol"] ?? "?"
      )}`;
    const isKaminoUsdcSol = (p: Record<string, unknown>): boolean => {
      const proto = String(p["protocol"] ?? p["source"] ?? p["platform"] ?? "").toLowerCase();
      const pair = String(p["pair"] ?? p["name"] ?? p["symbol"] ?? "").toLowerCase();
      return proto.includes("kamino") && pair.includes("usdc") && pair.includes("sol");
    };
    const sample = pools.find(isKaminoUsdcSol) ?? pools[0];
    const sm = asNum(sample["smartMoneyInflow7d"]);
    smStr =
      sm === undefined
        ? `${label(sample)} smartMoneyInflow7d なし(フィールド未存在)`
        : `${label(sample)}=${sm}`;
  }

  return `${head} apyResolved=${apyStr}, apySource(${sourceStr}), liveSources=${liveSourcesStr}, smartMoney例 ${smStr}`;
}
