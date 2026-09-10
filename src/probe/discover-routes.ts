/**
 * Read a service's advertised paid routes from its x402 metadata.
 *
 * run 0 could reach all five sellers but knew no paid routes, because it poked
 * /.well-known/x402 and /openapi.json without parsing them. This walks that
 * metadata and pulls out the routes that actually carry x402 payment
 * requirements, plus their price — so the sweep targets come from what the seller
 * advertises, never a guess.
 *
 * Two shapes are handled generically:
 *   - x402 discovery: anywhere in the tree, an object with an `accepts` array
 *     (a list of payment requirements) is a paid resource; its path comes from a
 *     sibling resource/path/route/url/endpoint key and its price from the
 *     cheapest accepts entry (amount ?? maxAmountRequired, /1e6).
 *   - OpenAPI: `paths` object → each key is a route; price is unknown from the
 *     spec alone, so it is left blank rather than invented.
 * Nothing is fabricated: a route with neither an accepts price nor a readable
 * path is dropped.
 */
import * as fs from "fs";
import * as path from "path";

export interface DiscoveredRoute {
  path: string;
  method?: string;
  /** Networks the paid requirement(s) offer. */
  networks?: string[];
  /** Cheapest readable price, in USDC. Undefined when the metadata doesn't say. */
  priceUsd?: number;
  /** Which metadata document it came from. */
  from: string;
}

const PATH_KEYS = ["resource", "path", "route", "url", "endpoint", "href"];

function firstString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

/** Path portion of a resource string (absolute URL or already a path). */
function toPath(resource: string): string {
  try {
    return new URL(resource.includes("://") ? resource : `https://x${resource}`).pathname;
  } catch {
    return resource.startsWith("/") ? resource : `/${resource}`;
  }
}

function priceOfAccept(a: unknown): number | undefined {
  if (!a || typeof a !== "object") return undefined;
  const o = a as Record<string, unknown>;
  const raw = (o.amount ?? o.maxAmountRequired) as unknown;
  if (raw === undefined || raw === null) return undefined;
  try {
    return Number(BigInt(String(raw))) / 1e6;
  } catch {
    return undefined;
  }
}

function networkOfAccept(a: unknown): string | undefined {
  if (!a || typeof a !== "object") return undefined;
  const n = (a as Record<string, unknown>).network;
  return typeof n === "string" ? n : undefined;
}

/** Every object node in a JSON tree (breadth-first, bounded). */
function* walk(root: unknown): Generator<Record<string, unknown>> {
  const queue: unknown[] = [root];
  let guard = 0;
  while (queue.length && guard < 5000) {
    guard++;
    const node = queue.shift();
    if (Array.isArray(node)) {
      for (const v of node) queue.push(v);
    } else if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      yield obj;
      for (const v of Object.values(obj)) if (v && typeof v === "object") queue.push(v);
    }
  }
}

export function parseAdvertisedRoutes(body: unknown, from: string): DiscoveredRoute[] {
  const out: DiscoveredRoute[] = [];
  const seen = new Set<string>();
  const add = (r: DiscoveredRoute): void => {
    const key = `${r.method ?? "GET"} ${r.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  };

  // x402 discovery: objects carrying an `accepts` array.
  for (const obj of walk(body)) {
    const accepts = obj["accepts"];
    if (!Array.isArray(accepts) || accepts.length === 0) continue;
    const resource = firstString(obj, PATH_KEYS);
    if (!resource) continue; // a price with no route is not a usable route
    const prices = accepts.map(priceOfAccept).filter((p): p is number => p !== undefined);
    const networks = [...new Set(accepts.map(networkOfAccept).filter((n): n is string => !!n))];
    add({
      path: toPath(resource),
      method: typeof obj["method"] === "string" ? String(obj["method"]).toUpperCase() : undefined,
      networks: networks.length ? networks : undefined,
      priceUsd: prices.length ? Math.min(...prices) : undefined,
      from,
    });
  }

  // OpenAPI fallback: paths → routes (price unknown from the spec).
  if (out.length === 0 && body && typeof body === "object") {
    const paths = (body as Record<string, unknown>)["paths"];
    if (paths && typeof paths === "object") {
      for (const [route, methods] of Object.entries(paths as Record<string, unknown>)) {
        if (!route.startsWith("/")) continue;
        const verbs =
          methods && typeof methods === "object"
            ? Object.keys(methods as Record<string, unknown>).filter((m) =>
                ["get", "post", "put", "delete", "patch"].includes(m.toLowerCase())
              )
            : [];
        add({ path: route, method: (verbs[0] ?? "get").toUpperCase(), from });
      }
    }
  }

  return out;
}

/** Persist a raw metadata body so an unrecognised shape can be read/pasted. */
export function saveRawMetadata(service: string, metaPath: string, body: unknown): string {
  const dir = path.join(process.cwd(), "data", "probe", "metadata");
  const slug = metaPath.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root";
  const file = path.join(dir, `${service}__${slug}.json`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
  return file;
}
