#!/usr/bin/env python3
"""Deploy the PledgeVault Intelligent Contract to GenLayer studionet.

Usage:
    source ~/.genlayer/env.sh
    python3 scripts/deploy_studionet.py
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from genlayer_py import create_account, create_client
from genlayer_py.chains import studionet

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "contracts" / "pledge_vault.py"


def get_address_from_receipt(receipt):
    if not receipt:
        return None
    if isinstance(receipt, dict):
        return (
            receipt.get("data", {}).get("contract_address")
            or receipt.get("contract_address")
            or receipt.get("contractAddress")
            or receipt.get("tx_data_decoded", {}).get("contract_address")
        )
    return getattr(receipt, "contract_address", None) or getattr(
        receipt, "contractAddress", None
    )


def main() -> int:
    key = os.environ.get("GENLAYER_PRIVATE_KEY")
    if not key or "REPLACE_ME" in key:
        print("ERROR: GENLAYER_PRIVATE_KEY not set. Run: source ~/.genlayer/env.sh", file=sys.stderr)
        return 1

    account = create_account(key)
    client = create_client(chain=studionet, account=account)
    code = CONTRACT.read_text()

    print("=" * 54)
    print("PledgeVault deploy — GenLayer studionet")
    print(f"Deployer: {account.address}")
    print(f"Chain:    {studionet.name} (id={studionet.id})")
    print("=" * 54)

    try:
        client.get_contract_schema_for_code(code.encode())
        print("[+] Schema check: PASSED")
    except Exception as e:
        print(f"[!] Schema check FAILED: {e}", file=sys.stderr)
        return 1

    tx_hash = client.deploy_contract(code=code, account=account)
    print(f"[+] Deploy tx: {tx_hash}")
    receipt = client.wait_for_transaction_receipt(
        transaction_hash=tx_hash, status="FINALIZED", interval=3000, retries=80
    )
    addr = get_address_from_receipt(receipt)
    if not addr:
        raise RuntimeError("Could not extract deployed address")
    print(f"[+] PledgeVault deployed at: {addr}")

    deployments = {
        "network": "studionet",
        "chainId": studionet.id,
        "deployer": account.address,
        "contract": "PledgeVault",
        "address": addr,
        "tx": tx_hash,
        "explorer": f"https://genlayer-explorer.vercel.app/address/{addr}",
    }
    (ROOT / "deployments.json").write_text(json.dumps(deployments, indent=2))
    print("[v] Wrote deployments.json")

    env_content = (
        f"VITE_PLEDGE_CONTRACT={addr}\n"
        f"VITE_STUDIO_RPC=https://studio.genlayer.com/api\n"
        f"VITE_CHAIN_ID={studionet.id}\n"
    )
    (ROOT / "frontend" / ".env").write_text(env_content)
    (ROOT / "frontend" / ".env.example").write_text(env_content.replace(addr, "0x..."))
    addr_ts = ROOT / "frontend" / "src" / "lib" / "addresses.ts"
    addr_ts.write_text(
        f"export const PLEDGE_CONTRACT = (import.meta.env.VITE_PLEDGE_CONTRACT || '{addr}') as `0x${{string}}`;\n"
        f"export const RPC_URL = import.meta.env.VITE_STUDIO_RPC || 'https://studio.genlayer.com/api';\n"
    )
    print("[v] Updated frontend/.env and addresses.ts")
    print("\nDEPLOYMENT COMPLETE:", addr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
