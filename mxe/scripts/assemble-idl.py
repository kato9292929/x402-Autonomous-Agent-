#!/usr/bin/env python3
"""Assemble the program IDL from `cargo test __anchor_private_print_idl --features idl-build`.

`anchor build` does this step itself, but it needs the Arcium toolchain (and so
Docker). The AA client only needs the IDL, and `cargo test` with the idl-build
feature prints every piece of it, so this joins them the way the Anchor CLI
does: the program block, plus the address, errors, and each event with its
types; crate paths ("aa_mxe::Foo") become bare names.

  python3 scripts/assemble-idl.py idl.out > idl/aa_mxe.json
  python3 scripts/assemble-idl.py --compare idl/aa_mxe.json target/idl/aa_mxe.json

The compare mode is what CI runs against the IDL `arcium build` writes, so the
committed copy cannot drift from the program.
"""
import json
import re
import sys

PREFIX = re.compile(r'"aa_mxe::')


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


if __name__ == "__main__":
    if sys.argv[1] == "--compare":
        a, b = (comparable(json.load(open(p))) for p in sys.argv[2:4])
        for key in ("instructions", "accounts", "events", "types", "errors"):
            if a.get(key) != b.get(key):
                names_a = {x["name"] for x in a.get(key, [])}
                names_b = {x["name"] for x in b.get(key, [])}
                diff = sorted(names_a ^ names_b) or sorted(
                    x["name"] for x in a.get(key, []) if x not in b.get(key, [])
                )
                print(f"IDL drift in {key}: {diff}")
                sys.exit(1)
        print("IDL matches")
    else:
        print(json.dumps(assemble(open(sys.argv[1]).read()), indent=2))
