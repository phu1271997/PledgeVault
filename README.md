# PledgeVault — Autonomous Kept-Promise Accountability Bond on GenLayer

> **A public promise is only as good as whoever gets to decide it was kept.**
> PledgeVault makes people put money behind their promises and hands the "did
> they actually do it?" decision to GenLayer validator consensus: AI validators
> fetch the fulfillment evidence *directly on-chain*, judge the promise honestly,
> and route the stake to the maker if KEPT or to a named beneficiary if BROKEN —
> with no trusted referee.

**Contract (studionet):** `0x6fBBEBfdf454c99408189C1F8A2F1dE8CBbb0D9e`
**Explorer:** https://genlayer-explorer.vercel.app/address/0x6fBBEBfdf454c99408189C1F8A2F1dE8CBbb0D9e
**Network:** GenLayer **studionet** (chain id `61999`), via GenLayer Studio.

_Verified live end-to-end: a staked promise with a dead evidence URL was judged
`BROKEN` (confidence 96) and 4.875 GEN routed to the beneficiary via the dispute
window + pull payout — all via real validator consensus. See
`scripts/e2e_studionet.py`._

---

## Why this dies without GenLayer

The core action is a **subjective judgment with money on it**: *"Given this
promise in the maker's own words and this evidence on the open web, was it
genuinely kept, only partly kept, or broken?"* That needs to (1) read arbitrary
real-world evidence (a release page, a shipped site, a published post) and (2)
reason about whether it satisfies a natural-language commitment. Solidity can do
neither, and any off-chain oracle just reintroduces the single trusted judge
PledgeVault exists to delete. Remove the AI + web layer and there is nothing
left to enforce a promise.

## How it works

```
Maker   ──create_pledge(statement, deadline, verifyURL, beneficiary, stake)──►  PledgeVault
Backers ──back_pledge(reward)──────────────────────────────────────────────►      │
                                                     (after deadline)               ▼
                          resolve()  ── gl.vm.run_nondet ──┐
                            leader_fn:  web.get(verifyURL)  │  AI validators
                                        exec_prompt(KEPT?)  │  reach consensus
                            validator_fn: compare verdict ──┘  on the VERDICT
                                                                                    ▼
                    DISPUTE window (bonded rebuttal can flip the verdict)
                                                                                    ▼
     finalize():  KEPT → maker · BROKEN → beneficiary · PARTIAL → split   (pull-payout)
```

1. **Create.** A maker stakes ≥ 2 GEN, writes the promise in plain language,
   sets a deadline, gives a **verification URL** where fulfillment evidence will
   live, and names a **beneficiary** who receives the funds if the promise is
   broken (e.g. a charity, a DAO treasury, or the backers).
2. **Back (optional).** Anyone can add to a **reward pool** that follows the
   verdict — it goes to the maker on KEPT, to the beneficiary on BROKEN.
3. **Resolve.** After the deadline, *anyone* can call `resolve`. A
   non-deterministic block fetches the evidence on-chain and asks each
   validator's LLM for `{verdict, confidence, reason}`. Consensus is on
   **meaning**: the custom `validator_fn` requires validators to agree on the
   **verdict** (KEPT / BROKEN / PARTIAL), not on the wording of `reason`.
4. **Dispute.** A **dispute window** opens. Anyone may post a **bonded rebuttal**
   (≥ 1 GEN) with additional evidence, which re-runs consensus over both
   sources. A rebuttal that **changes** the verdict refunds its bond; one that
   fails forfeits it to the fee pool.
5. **Finalize & withdraw.** After the window, `finalize` routes stake + reward
   pool (minus a 2.5% protocol fee) per the verdict, credited via a **pull
   pattern** (`finalize` → `withdraw`).

### Consensus that checks meaning, not shape (Axis 2)

```python
def validator_fn(leader_res) -> bool:
    if not isinstance(leader_res, gl.vm.Return):
        return False
    leader = leader_res.calldata
    mine = leader_fn()                       # validator re-derives independently
    if mine["verdict"] != leader["verdict"]: # ✅ agree on the DECISION, not text
        return False
    return (mine["confidence"] >= 60) == (leader["confidence"] >= 60)
```

Two validators that write different `reason` text still agree; two that reach
KEPT vs BROKEN do **not** — the line PledgeVault must hold to be fair to both the
maker and the beneficiary.

### Advanced non-determinism (Axis 2 → 5)

- **Bonded dispute / appeal round** at the contract layer that fetches a *second*
  independent evidence source and re-runs consensus, able to overturn the first
  verdict.
- **Three-way subjective verdict** (KEPT / BROKEN / PARTIAL) with a confidence
  band, plus a PARTIAL settlement that splits funds — richer than a binary.

## Edge cases handled (each with `UserError`)

- Stake < 2 GEN, dispute bond < 1 GEN, non-HTTPS verify/rebuttal URL → rejected.
- Deadline in the past, statement too short/long → rejected.
- `resolve` before the deadline, `dispute` outside the window, `finalize` before
  the window elapses, double-resolve → all revert.
- Web fetch failure / dead link → captured as `[FETCH_ERROR ...]` and judged as
  "not kept" rather than crashing.
- `withdraw` with a zero balance → reverts; pull-pattern payouts can't wedge.

## Repository layout

```
contracts/pledge_vault.py     # the GenLayer Intelligent Contract
docs/PLEDGE.md                # how a verification URL / evidence should look
tests/                        # gltest: happy path + adversarial + mocked consensus
scripts/deploy_studionet.py   # schema-gated deploy + writes frontend/.env
scripts/e2e_studionet.py      # live multi-wallet end-to-end exerciser
frontend/                     # Vite + React + Tailwind dApp (genlayer-js)
deployments.json              # deployed address + tx + explorer link
```

## Deploy to studionet (step by step)

```bash
source ~/.genlayer/env.sh
python3 scripts/deploy_studionet.py     # schema pre-flight + writes frontend/.env
python3 scripts/e2e_studionet.py        # optional live 3-wallet walkthrough
```

Confirm the deploy tx shows **`Result: SUCCESS`** in the Explorer, not just
`Status: FINALIZED`.

## Run the frontend

```bash
cd frontend
npm install
npm run dev        # http://localhost:3000
```

Signs with **MetaMask** (no key in the bundle), auto-switches to studionet on
connect, shows a consensus loading state, and renders the AI's `reason` with an
Explorer link for every verdict.

> **Wallet rule:** connect a wallet **already funded with GEN on studionet**
> (fund from the Studio **Accounts** panel). No testnet faucet is involved.

## Tests

```bash
source ~/.genlayer/env.sh
cd tests && gltest --network studionet
```

## Runtime note — deadline & dispute window

Deadlines and the dispute window use the GenVM wall-clock
(`gl.vm.get_timestamp()`). On the current hosted studionet build that clock is
not exposed, so the contract detects the missing clock (epoch `0`) and treats the
deadline/window as **advisory** (resolve and finalize are permitted). On any
build that exposes the clock, the deadline and dispute-window time-gates are
enforced automatically with no code change.

## Tech

Python Intelligent Contract (GenVM) · `gl.vm.run_nondet` semantic consensus ·
`gl.nondet.web.get` / `exec_prompt` · genlayer-js · Vite + React + Tailwind ·
deployed on GenLayer studionet.

## License

MIT © 2026
