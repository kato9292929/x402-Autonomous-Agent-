#!/usr/bin/env python3
"""Assemble the program IDL from `cargo test __anchor_private_print_idl --features idl-build`.

`anchor build` does this step itself, but it needs the Arcium toolchain (and so
Docker). The AA client only needs the IDL, and `cargo test` with the idl-build
feature prints every piece of it, so this joins them the way the Anchor CLI
does: the program block, plus the address, errors, and each event with its
types; crate paths ("aa_mxe::Foo", "arcium_anchor::Bar") become bare names.

  python3 scripts/assemble-idl.py idl.out > idl/aa_mxe.json
  python3 scripts/assemble-idl.py --compare idl/aa_mxe.json target/idl/aa_mxe.json

The compare mode is what CI runs against the IDL `arcium build` writes, so the
committed copy cannot drift from the program.
"""
import json
import re
import sys

# The Anchor CLI drops every crate path ("arcium_anchor::SharedEncryptedStruct",
# "arcium_client::idl::arcium::types::CircuitSource"), not only this crate's.
PREFIX = re.compile(r'"(?:[a-z_][a-z0-9_]*::)+(?=[A-Za-z])')


def blocks(text, kind):
    return re.findall(r"--- IDL begin %s ---\n(.*?)\n--- IDL end %s ---" % (kind, kind), text, re.S)


def assemble(text):
    idl = json.loads(blocks(text, "program")[0])
    addr = json.loads(blocks(text, "address")[0])
    idl["address"] = json.loads(addr) if addr.startswith('"') else addr
    errs = blocks(text, "errors")
    if errs:
        idl["errors"] = json.loads(errs[0])
    types = {t["name"]: t for t in idl.get("types", [])}
    events = []
    for b in blocks(text, "event"):
        e = json.loads(b)
        events.append(e["event"])
        for t in e.get("types", []):
            types.setdefault(t["name"], t)
    idl["events"] = events
    idl["types"] = list(types.values())
    out = json.loads(PREFIX.sub('"', json.dumps(idl)))
    return normalize(out)


def normalize(idl):
    """Order-insensitive form: lists of named items sorted by name."""
    for key in ("instructions", "accounts", "events", "types", "errors"):
        if key in idl:
            idl[key] = sorted(idl[key], key=lambda x: x["name"])
    return idl


def comparable(idl):
    idl = normalize(json.loads(json.dumps(idl)))
    idl.pop("address", None)  # the devnet build rewrites declare_id
    # The CLI may add `docs` or account `address`/`pda` resolution the raw
    # print lacks; neither changes the wire format the client relies on.
    for ix in idl.get("instructions", []):
        ix.pop("docs", None)
        for a in ix.get("accounts", []):
            for k in ("address", "pda", "docs", "relations", "optional"):
                a.pop(k, None)
    for k in ("docs",):
        idl.pop(k, None)
    return idl


def report(a, b):
    """Differences between two comparable IDLs, as short text lines."""
    import difflib

    out = []
    for key in ("instructions", "accounts", "events", "types", "errors"):
        xa = {x["name"]: x for x in a.get(key, [])}
        xb = {x["name"]: x for x in b.get(key, [])}
        for n in sorted(set(xa) - set(xb)):
            out.append(f"{key}: only in committed: {n}")
        for n in sorted(set(xb) - set(xa)):
            out.append(f"{key}: only in build: {n}")
        for n in sorted(set(xa) & set(xb)):
            if xa[n] != xb[n]:
                da = json.dumps(xa[n], indent=1, sort_keys=True).splitlines()
                db = json.dumps(xb[n], indent=1, sort_keys=True).splitlines()
                diff = list(difflib.unified_diff(da, db, "committed", "build", n=1, lineterm=""))
                out.append(f"{key}: {n} differs")
                out.extend("  " + d for d in diff[2:40])
    for key in sorted(set(a) | set(b)):
        if key not in ("instructions", "accounts", "events", "types", "errors") and a.get(key) != b.get(key):
            out.append(f"top-level {key}: committed={json.dumps(a.get(key))[:200]} build={json.dumps(b.get(key))[:200]}")
    return out


if __name__ == "__main__":
    if sys.argv[1] == "--compare":
        a, b = (comparable(json.load(open(p))) for p in sys.argv[2:4])
        lines = report(a, b)
        if lines:
            print("IDL drift:")
            print("\n".join(lines[:200]))
            sys.exit(1)
        print("IDL matches")
    else:
        print(json.dumps(assemble(open(sys.argv[1]).read()), indent=2))
