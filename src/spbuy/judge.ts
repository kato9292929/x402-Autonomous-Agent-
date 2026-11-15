/**
 * Whether a body bought through the Seller Probe–driven path is what the seller
 * described — the same five checks Seller Probe uses for its "説明どおり" verdict,
 * so a result here can be compared with (and handed back to) Seller Probe.
 *
 * Ported from kato9292929/seller-probe src/curated/judge.ts (contentChecks,
 * schemaProblems, promisedFreshness) and src/curated/request.ts (the output
 * definition read from a 402). Kept as close to the original as possible; when
 * Seller Probe changes its rules, change this file the same way.
 */

export type CheckName = "output_schema" | "not_empty" | "input_reflected" | "freshness" | "data_kind";
export interface Check {
  name: CheckName;
  result: "pass" | "fail" | "not_checked";
  detail: string;
}

/** What the seller says it returns: from the 402 (v2 extensions.bazaar, v1 accepts[].outputSchema). */
export interface OutputDef {
  type: string | null;
  example: unknown;
  schema: any;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Seller Probe's fromBazaarShape, output part only. */
function outputFrom(output: any, outputSchema: any): OutputDef | null {
  const wrapperKeys = Object.keys(outputSchema?.properties ?? {});
  const isWrapper = wrapperKeys.length > 0 && wrapperKeys.every((k) => ["type", "example", "schema"].includes(k));
  const exSchema =
    outputSchema?.properties?.example ?? (outputSchema?.type && outputSchema?.properties && !isWrapper ? outputSchema : null);
  return output || exSchema ? { type: output?.type ?? null, example: output?.example ?? null, schema: exSchema } : null;
}

/** The output definition a 402 document carries, if any. */
export function outputFromPaymentRequired(doc: any): OutputDef | null {
  const bz = doc?.extensions?.bazaar;
  if (isObj(bz)) {
    const o = outputFrom(bz.info?.output, bz.schema?.properties?.output);
    if (o) return o;
  }
  for (const a of doc?.accepts ?? []) {
    const os = a?.outputSchema;
    if (!isObj(os) || !os.output) continue;
    const o = outputFrom(os.output && !os.output.properties ? { example: os.output } : null, os.output?.properties ? os.output : null);
    if (o) return o;
  }
  return null;
}

const tryJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};
const typeOf = (v: unknown) =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;
const typeOk = (want: unknown, v: unknown) => {
  const ws = (Array.isArray(want) ? want : [want]).filter((x) => typeof x === "string") as string[];
  if (!ws.length) return true;
  const t = typeOf(v);
  return ws.some((w) => w === t || (w === "number" && t === "integer"));
};

/** Required fields and types of a JSON Schema, two levels deep. */
export function schemaProblems(schema: any, v: unknown, path = "$", depth = 0): string[] {
  if (!schema || typeof schema !== "object" || depth > 2) return [];
  const out: string[] = [];
  if (schema.type && !typeOk(schema.type, v)) return [`${path}: expected ${JSON.stringify(schema.type)}, got ${typeOf(v)}`];
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of Array.isArray(schema.required) ? schema.required : []) if (!(k in (v as any))) out.push(`${path}.${k}: missing`);
    for (const [k, sub] of Object.entries<any>(schema.properties ?? {}))
      if (k in (v as any)) out.push(...schemaProblems(sub, (v as any)[k], `${path}.${k}`, depth + 1));
  }
  return out;
}

const ERROR_KEYS = ["error", "errors", "err", "message"];
const PLACEHOLDER_BODY =
  /lorem ipsum|\bplaceholder\b|coming soon|not (yet )?implemented|\bTODO\b|\bmock(ed)? (data|response)\b|\bdummy (data|response)\b|sample response/i;

function newestTimestamp(v: unknown, now: number, depth = 0): number | null {
  if (depth > 4 || v === null || v === undefined) return null;
  let best: number | null = null;
  const consider = (t: number | null) => {
    if (t !== null && t <= now + 3_600_000 && t > Date.UTC(2015, 0, 1)) best = best === null ? t : Math.max(best, t);
  };
  if (Array.isArray(v)) for (const x of v.slice(0, 50)) consider(newestTimestamp(x, now, depth + 1));
  else if (typeof v === "object")
    for (const [k, x] of Object.entries(v as any)) {
      if (/time|date|updated|_at$|^ts$|timestamp|as_?of|last/i.test(k)) {
        if (typeof x === "string" && /^\d{4}-\d{2}-\d{2}/.test(x)) consider(Date.parse(x));
        else if (typeof x === "number") consider(x > 1e12 ? x : x * 1000);
      }
      if (x && typeof x === "object") consider(newestTimestamp(x, now, depth + 1));
    }
  return best;
}

/** How fresh the description promises the data to be, in ms; null when it says nothing measurable. */
export function promisedFreshness(description: string | null | undefined): { ms: number; said: string } | null {
  const d = (description ?? "").toLowerCase();
  const every = d.match(/every (\d+)\s*(second|sec|minute|min|hour)s?/);
  if (every) {
    const n = Number(every[1]) * (every[2].startsWith("h") ? 3_600_000 : every[2].startsWith("m") ? 60_000 : 1000);
    return { ms: Math.max(n * 3, 3_600_000), said: every[0] };
  }
  const m = d.match(/real[- ]?time|\blive\b|\blatest\b|up[- ]to[- ]the[- ]minute/);
  if (m) return { ms: 6 * 3_600_000, said: m[0] };
  if (/\bhourly\b/.test(d)) return { ms: 6 * 3_600_000, said: "hourly" };
  if (/\bdaily\b/.test(d)) return { ms: 3 * 86_400_000, said: "daily" };
  return null;
}

function expectedKind(description: string | null | undefined, outputType: string | null | undefined): "audio" | "image" | "json" | null {
  const d = (description ?? "").toLowerCase();
  if (/\b(tts|text[- ]to[- ]speech|audio|mp3|speech synthesis)\b/.test(d) && !/speech[- ]to[- ]text|transcri/.test(d)) return "audio";
  if (/\b(generate|create)s? (an? )?images?\b|\bimage generation\b|\bpng\b/.test(d)) return "image";
  if (outputType === "json") return "json";
  return null;
}

const REFLECT_NAME = /^(symbol|ticker|address|wallet|token_?address|contract|city|location|pair|coin|coin_?id|ids?|domain|url)$/i;

/** The five checks on a delivered body. `values` are the request's inputs. */
export function contentChecks(a: {
  body: Buffer;
  contentType: string | null;
  description: string | null;
  output: OutputDef | null;
  values: { name: string; value: unknown }[];
  now?: Date;
}): Check[] {
  const now = (a.now ?? new Date()).getTime();
  const text = a.body.toString("utf8");
  const json = tryJson(text);
  const checks: Check[] = [];

  // 1. output schema: required fields and types
  const schema = a.output?.schema;
  if (schema && (schema.required?.length || schema.properties)) {
    if (json === undefined) checks.push({ name: "output_schema", result: "fail", detail: "the schema describes JSON; the body is not JSON" });
    else {
      const p = schemaProblems(schema, json);
      checks.push(
        p.length
          ? { name: "output_schema", result: "fail", detail: p.slice(0, 5).join("; ") }
          : { name: "output_schema", result: "pass", detail: "required fields and types match" }
      );
    }
  } else checks.push({ name: "output_schema", result: "not_checked", detail: "no output schema published" });

  // 2. not empty, not an error, not a placeholder
  const trimmed = text.trim();
  let empty: string | null = null;
  if (!trimmed) empty = "empty body";
  else if (json !== undefined && (json === null || (typeof json === "object" && Object.keys(json as object).length === 0))) empty = "empty JSON";
  else if (json && typeof json === "object" && !Array.isArray(json)) {
    const o = json as Record<string, unknown>;
    const keys = Object.keys(o);
    if (o.success === false || o.ok === false) empty = `success: false (${String(o.error ?? o.message ?? "").slice(0, 80)})`;
    else if (keys.length <= 3 && keys.some((k) => ERROR_KEYS.includes(k)) && (o.error || o.errors)) empty = `error object: ${JSON.stringify(o).slice(0, 120)}`;
  }
  if (!empty && PLACEHOLDER_BODY.test(trimmed.slice(0, 5000))) empty = `placeholder text: "${trimmed.match(PLACEHOLDER_BODY)![0]}"`;
  if (!empty && a.values.length && a.output?.example && json !== undefined && JSON.stringify(json) === JSON.stringify(a.output.example))
    empty = "the body is the published example, verbatim";
  checks.push(empty ? { name: "not_empty", result: "fail", detail: empty } : { name: "not_empty", result: "pass", detail: `${a.body.length} bytes` });

  // 3. input reflected in the output
  const ids = a.values.filter(
    (v) => REFLECT_NAME.test(v.name) && (typeof v.value === "string" || typeof v.value === "number") && String(v.value).length >= 2
  );
  if (!ids.length) checks.push({ name: "input_reflected", result: "not_checked", detail: "no identifier-like input to look for" });
  else {
    const hay = text.toLowerCase();
    const variants = (s: string) => {
      const l = s.toLowerCase();
      return [l, l.replace(/^https?:\/\//, "").replace(/\/$/, ""), ...l.split(/[-/_,]/).filter((x) => x.length >= 3)];
    };
    const missing = ids.filter((v) => !variants(String(v.value)).some((x) => hay.includes(x)));
    checks.push(
      missing.length === ids.length
        ? { name: "input_reflected", result: "fail", detail: `none of ${ids.map((v) => `${v.name}=${v.value}`).join(", ")} appears in the output` }
        : { name: "input_reflected", result: "pass", detail: `${ids.filter((v) => !missing.includes(v)).map((v) => v.name).join(", ")} found in the output` }
    );
  }

  // 4. freshness against the described update frequency
  const promise = promisedFreshness(a.description);
  if (!promise) checks.push({ name: "freshness", result: "not_checked", detail: "the description states no update frequency" });
  else {
    const t = json === undefined ? null : newestTimestamp(json, now);
    if (t === null) checks.push({ name: "freshness", result: "not_checked", detail: `"${promise.said}" promised; no timestamp in the output` });
    else {
      const age = now - t;
      checks.push(
        age > promise.ms
          ? { name: "freshness", result: "fail", detail: `"${promise.said}" promised; newest timestamp ${new Date(t).toISOString()} is ${Math.round(age / 3_600_000)}h old` }
          : { name: "freshness", result: "pass", detail: `newest timestamp ${new Date(t).toISOString()}` }
      );
    }
  }

  // 5. kind of data matches the description
  const kind = expectedKind(a.description, a.output?.type);
  const ct = (a.contentType ?? "").toLowerCase();
  if (!kind) checks.push({ name: "data_kind", result: "not_checked", detail: "no data kind stated" });
  else if (kind === "json")
    checks.push(json !== undefined ? { name: "data_kind", result: "pass", detail: "JSON as described" } : { name: "data_kind", result: "fail", detail: `JSON described; got ${ct || "non-JSON"}` });
  else {
    const binary = ct.startsWith(`${kind}/`);
    const linked =
      json !== undefined &&
      new RegExp(`(https?://\\S+\\.(${kind === "audio" ? "mp3|wav|ogg|m4a" : "png|jpe?g|webp|gif"}))|"data:${kind}/|"(audio|image|url|b64_json|base64)"\\s*:`, "i").test(text);
    checks.push(
      binary || linked
        ? { name: "data_kind", result: "pass", detail: binary ? ct : `${kind} referenced in JSON` }
        : { name: "data_kind", result: "fail", detail: `${kind} described; got ${ct || "unknown"} without ${kind}` }
    );
  }
  return checks;
}
