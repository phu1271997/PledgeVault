#!/usr/bin/env python3
"""Live end-to-end walkthrough of PledgeVault on studionet with 3 real wallets.

    source ~/.genlayer/env.sh
    python3 scripts/e2e_studionet.py

Wallets:
    GENLAYER_PRIVATE_KEY    -> admin / deployer (also the beneficiary here)
    GENLAYER_PRIVATE_KEY_2  -> maker (stakes on a promise)
    GENLAYER_PRIVATE_KEY_3  -> backer (adds to the reward pool)

Exercises real AI + web consensus:
  create_pledge -> back_pledge -> resolve (KEPT) -> finalize -> withdraw ;
  plus a broken promise (dead evidence URL) -> resolve (BROKEN) -> beneficiary.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

from genlayer_py import create_account, create_client
from genlayer_py.chains import studionet

ROOT = Path(__file__).resolve().parent.parent
GEN = 10**18

KEPT_URL = "https://raw.githubusercontent.com/phu1271997/PledgeVault/b47beef145573d751409e0673018b511a8acdf3d/docs/evidence-v1.md"
# Non-existent path -> 404 / fetch error -> the arbiter should judge BROKEN.
BROKEN_URL = "https://raw.githubusercontent.com/phu1271997/PledgeVault/b47beef145573d751409e0673018b511a8acdf3d/docs/does-not-exist.md"

PAST = 1000000000   # deadline already elapsed (2001)
WINDOW = 30


def addr():
    return json.loads((ROOT / "deployments.json").read_text())["address"]


CONTRACT = addr()


def w(client, account, fn, args, value=0, label=""):
    print(f"  -> {label or fn} ...", flush=True)
    tx = client.write_contract(address=CONTRACT, function_name=fn, args=args,
                               account=account, value=value)
    client.wait_for_transaction_receipt(transaction_hash=tx, status="FINALIZED",
                                        interval=3000, retries=80)
    return tx


def r(client, fn, args):
    return client.read_contract(address=CONTRACT, function_name=fn, args=args)


def main() -> int:
    k1 = os.environ.get("GENLAYER_PRIVATE_KEY")
    k2 = os.environ.get("GENLAYER_PRIVATE_KEY_2")
    k3 = os.environ.get("GENLAYER_PRIVATE_KEY_3")
    if not all([k1, k2, k3]) or any("REPLACE_ME" in (x or "") for x in [k1, k2, k3]):
        print("ERROR: need GENLAYER_PRIVATE_KEY, _2, _3. Run: source ~/.genlayer/env.sh", file=sys.stderr)
        return 1

    admin = create_account(k1)      # beneficiary
    maker = create_account(k2)
    backer = create_account(k3)
    client = create_client(chain=studionet, account=admin)

    print("=" * 60)
    print(f"PledgeVault e2e — contract {CONTRACT}")
    print(f"maker={maker.address}\nbacker={backer.address}\nbeneficiary(admin)={admin.address}")
    print("=" * 60)

    # 1. Maker creates a KEPT-able pledge
    print("\n[1] maker stakes 2 GEN on 'ship v1.0' (evidence proves it shipped)")
    w(client, maker, "create_pledge",
      ["Ship widget v1.0",
       "I will publish a tagged v1.0 release of acme/widget with working install instructions by the deadline.",
       KEPT_URL, admin.address, PAST, WINDOW], value=2 * GEN, label="create_pledge")
    pledges = json.loads(r(client, "list_pledges", ["ALL", 0, 50]))
    pid = pledges[-1]["pledge_id"]
    print(f"    pledge_id={pid}, state={pledges[-1]['state']}")

    # 2. Backer adds to the reward pool
    print("\n[2] backer adds 3 GEN to the reward pool")
    w(client, backer, "back_pledge", [pid], value=3 * GEN, label="back_pledge")
    p = json.loads(r(client, "get_pledge", [pid]))
    print(f"    stake={int(p['stake'])/GEN} pool={int(p['support_pool'])/GEN} GEN")

    # 3. Resolve via AI consensus
    print("\n[3] resolve -> GenLayer validator consensus (slow)")
    w(client, maker, "resolve", [pid], label="resolve")
    p = json.loads(r(client, "get_pledge", [pid]))
    print(f"    VERDICT={p['verdict']} conf={p['confidence']} state={p['state']}")
    print(f"    reason: {p['reason'][:280]}")

    # 4. Finalize + maker withdraws (KEPT -> maker gets stake + pool - fee)
    if p["state"] == "DISPUTE":
        print(f"\n[4] wait out {WINDOW}s dispute window, finalize")
        time.sleep(WINDOW + 8)
        w(client, maker, "finalize", [pid], label="finalize")
        p = json.loads(r(client, "get_pledge", [pid]))
        print(f"    state={p['state']}")
        target = maker.address if p["verdict"] == "KEPT" else admin.address
        bal = r(client, "get_balance", [target])
        who = "maker" if p["verdict"] == "KEPT" else "beneficiary"
        print(f"    {who} claimable = {int(bal)/GEN} GEN")
        if p["verdict"] == "KEPT" and int(bal) > 0:
            print("\n[5] maker withdraw()")
            w(client, maker, "withdraw", [], label="withdraw")
            print(f"    balance after withdraw = {int(r(client,'get_balance',[maker.address]))/GEN} GEN")

    # 6. A broken promise: dead evidence URL -> BROKEN -> beneficiary
    print("\n[6] maker stakes 2 GEN on a promise with a DEAD evidence URL -> expect BROKEN")
    w(client, maker, "create_pledge",
      ["Launch the app",
       "I will launch my app and the proof will live at the verification URL by the deadline.",
       BROKEN_URL, admin.address, PAST, WINDOW], value=2 * GEN, label="create_pledge(broken)")
    pledges = json.loads(r(client, "list_pledges", ["ALL", 0, 50]))
    bpid = pledges[-1]["pledge_id"]
    w(client, maker, "resolve", [bpid], label="resolve(broken)")
    bp = json.loads(r(client, "get_pledge", [bpid]))
    print(f"    VERDICT={bp['verdict']} state={bp['state']}")
    print(f"    reason: {bp['reason'][:240]}")

    print("\n[stats]", r(client, "get_stats", []))
    print("\nE2E COMPLETE.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
