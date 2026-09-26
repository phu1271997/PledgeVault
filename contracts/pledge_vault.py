# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *

from dataclasses import dataclass
import json


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _run_nondet(leader_fn, validator_fn):
    """Default to the sandboxed gl.vm.run_nondet (project rule D3);
    fall back to run_nondet_unsafe only if the Studio build lacks it."""
    fn = (
        getattr(gl.vm, "run_nondet", None)
        or getattr(gl.vm, "run_nondet_default", None)
        or gl.vm.run_nondet_unsafe
    )
    return fn(leader_fn, validator_fn)


def _addr_str(addr: Address) -> str:
    try:
        return addr.as_hex
    except Exception:
        return str(addr)


def _now_epoch() -> bigint:
    try:
        return bigint(int(gl.vm.get_timestamp().timestamp()))
    except Exception:
        return bigint(0)


def _is_https(url: str) -> bool:
    u = url.strip().lower()
    if not u.startswith("https://"):
        return False
    if "@" in u or "localhost" in u or "127.0.0.1" in u:
        return False
    return True


@allow_storage
@dataclass
class Pledge:
    maker: str
    title: str
    statement: str            # the promise, in the maker's own words
    verify_url: str           # where fulfillment evidence will live
    beneficiary: str          # receives the funds if the promise is BROKEN
    deadline_epoch: bigint    # promise due date
    dispute_window_secs: bigint
    stake: bigint             # maker's staked amount
    support_pool: bigint      # backers' added rewards
    state: str                # ACTIVE | DISPUTE | SETTLED
    verdict: str              # "" | KEPT | BROKEN | PARTIAL
    reason: str
    confidence: u8
    resolve_deadline: bigint  # end of the dispute window
    rebuttal_url: str
    created_at: bigint


class Contract(gl.Contract):
    admin: Address
    next_id: bigint
    pledges: TreeMap[str, Pledge]
    balances: TreeMap[str, bigint]     # pull-pattern withdrawable balances
    fee_pool: bigint

    MIN_STAKE = bigint(2 * 10**18)         # 2 GEN
    MIN_DISPUTE_BOND = bigint(1 * 10**18)  # 1 GEN
    FEE_BPS = bigint(250)                  # 2.5%
    DEFAULT_DISPUTE = bigint(3 * 24 * 3600)  # 3 days

    def __init__(self):
        self.admin = gl.message.sender_address
        self.next_id = bigint(1)
        self.fee_pool = bigint(0)

    # -----------------------------------------------------------------
    # Create / back
    # -----------------------------------------------------------------
    @gl.public.write.payable
    def create_pledge(
        self,
        title: str,
        statement: str,
        verify_url: str,
        beneficiary: Address,
        deadline_epoch: int,
        dispute_window_secs: int,
    ) -> str:
        if gl.message.value < u256(int(self.MIN_STAKE)):
            raise gl.vm.UserError("Stake must be at least 2 GEN")
        if not title or len(title.strip()) == 0:
            raise gl.vm.UserError("Title required")
        if len(title) > 140:
            raise gl.vm.UserError("Title too long")
        if len(statement.strip()) < 10:
            raise gl.vm.UserError("Statement too short to be verifiable")
        if len(statement) > 1000:
            raise gl.vm.UserError("Statement too long")
        if not _is_https(verify_url):
            raise gl.vm.UserError("Verification URL must be HTTPS")
        if deadline_epoch <= int(_now_epoch()):
            raise gl.vm.UserError("Deadline must be in the future")

        window = bigint(dispute_window_secs) if dispute_window_secs > 0 else self.DEFAULT_DISPUTE

        pid_int = int(self.next_id)
        self.next_id = bigint(pid_int + 1)
        pid = str(pid_int)

        self.pledges[pid] = Pledge(
            maker=_addr_str(gl.message.sender_address),
            title=title.strip(),
            statement=statement.strip(),
            verify_url=verify_url.strip(),
            beneficiary=_addr_str(beneficiary),
            deadline_epoch=bigint(deadline_epoch),
            dispute_window_secs=window,
            stake=bigint(gl.message.value),
            support_pool=bigint(0),
            state="ACTIVE",
            verdict="",
            reason="",
            confidence=u8(0),
            resolve_deadline=bigint(0),
            rebuttal_url="",
            created_at=_now_epoch(),
        )
        return pid

    @gl.public.write.payable
    def back_pledge(self, pledge_id: str) -> None:
        """Backers add to the reward pool: it follows the verdict — to the maker
        if the promise is KEPT, to the beneficiary if BROKEN."""
        if pledge_id not in self.pledges:
            raise gl.vm.UserError("Pledge not found")
        p = self.pledges[pledge_id]
        if p.state != "ACTIVE":
            raise gl.vm.UserError("Pledge is no longer active")
        if gl.message.value == u256(0):
            raise gl.vm.UserError("Backing must be positive")
        p.support_pool = p.support_pool + bigint(gl.message.value)

    # -----------------------------------------------------------------
    # Resolve (consensus) — anyone can trigger after the deadline
    # -----------------------------------------------------------------
    def _fetch(self, url: str) -> str:
        try:
            res = gl.nondet.web.get(url)
            if hasattr(res, "body"):
                return res.body.decode("utf-8", errors="replace")
            return str(res)
        except Exception:
            try:
                return gl.nondet.web.render(url, mode="text")
            except Exception as e:
                return f"[FETCH_ERROR] {str(e)[:200]}"

    def _judge_prompt(self, statement, evidence, deadline, extra) -> str:
        extra_block = ""
        if extra:
            extra_block = f"""
ADDITIONAL DISPUTE EVIDENCE (fetched on-chain, weigh it against the above):
{extra[:4000]}
"""
        return f"""You are an impartial accountability arbiter running inside a GenLayer
Intelligent Contract. A person staked money on a public promise and named a
deadline. Decide, ONLY from the evidence fetched on-chain, whether they kept it.

THE PROMISE (verbatim):
{statement[:2000]}

PROMISE DEADLINE (unix seconds): {deadline}

FULFILLMENT EVIDENCE (fetched on-chain from the maker's verification URL):
{evidence[:6000]}
{extra_block}
Judge honestly and skeptically:
1. Does the evidence actually demonstrate the specific promised outcome — not a
   vague gesture toward it?
2. Was it fulfilled by the deadline the evidence can show?
3. If only part of the promise was delivered, that is PARTIAL, not KEPT.
Treat a dead link, empty page, unrelated content, or unverifiable self-claim as
NOT kept.

RESPOND WITH ONLY VALID JSON, no markdown fence:
{{
  "verdict": "KEPT" | "BROKEN" | "PARTIAL",
  "confidence": 0-100,
  "reason": "2-4 sentences citing the specific evidence"
}}"""

    @gl.public.write
    def resolve(self, pledge_id: str) -> None:
        if pledge_id not in self.pledges:
            raise gl.vm.UserError("Pledge not found")
        p = self.pledges[pledge_id]
        if p.state != "ACTIVE":
            raise gl.vm.UserError("Pledge is not active")
        if _now_epoch() < p.deadline_epoch:
            raise gl.vm.UserError("Cannot resolve before the deadline")

        statement = p.statement
        verify_url = p.verify_url
        deadline = int(p.deadline_epoch)

        def leader_fn():
            evidence = self._fetch(verify_url)
            return gl.nondet.exec_prompt(
                self._judge_prompt(statement, evidence, deadline, ""),
                response_format="json",
            )

        def validator_fn(leader_res) -> bool:
            # Consensus on MEANING: the verdict + the confidence band.
            if not isinstance(leader_res, gl.vm.Return):
                return False
            leader = leader_res.calldata
            if not isinstance(leader, dict) or "verdict" not in leader:
                return False
            mine = leader_fn()
            if not isinstance(mine, dict) or "verdict" not in mine:
                return False
            if str(mine["verdict"]).upper() != str(leader["verdict"]).upper():
                return False
            mc = int(mine.get("confidence", 0))
            lc = int(leader.get("confidence", 0))
            return (mc >= 60) == (lc >= 60)

        result = _run_nondet(leader_fn, validator_fn)
        self._set_tentative(pledge_id, result)

    def _set_tentative(self, pledge_id: str, result) -> None:
        p = self.pledges[pledge_id]
        verdict = str(result.get("verdict", "BROKEN")).upper()
        if verdict not in ("KEPT", "BROKEN", "PARTIAL"):
            verdict = "BROKEN"
        p.verdict = verdict
        p.reason = str(result.get("reason", ""))
        p.confidence = u8(max(0, min(100, int(result.get("confidence", 0)))))
        p.state = "DISPUTE"
        p.resolve_deadline = _now_epoch() + p.dispute_window_secs

    # -----------------------------------------------------------------
    # Dispute (bonded, re-runs consensus with new evidence)
    # -----------------------------------------------------------------
    @gl.public.write.payable
    def dispute(self, pledge_id: str, rebuttal_url: str) -> None:
        if pledge_id not in self.pledges:
            raise gl.vm.UserError("Pledge not found")
        p = self.pledges[pledge_id]
        if p.state != "DISPUTE":
            raise gl.vm.UserError("Pledge is not in a dispute window")
        if _now_epoch() > p.resolve_deadline:
            raise gl.vm.UserError("Dispute window has expired")
        if gl.message.value < u256(int(self.MIN_DISPUTE_BOND)):
            raise gl.vm.UserError("Dispute bond must be at least 1 GEN")
        if not _is_https(rebuttal_url):
            raise gl.vm.UserError("Rebuttal URL must be HTTPS")

        bond = bigint(gl.message.value)
        challenger = _addr_str(gl.message.sender_address)
        p.rebuttal_url = rebuttal_url.strip()

        statement = p.statement
        verify_url = p.verify_url
        rb_url = p.rebuttal_url
        deadline = int(p.deadline_epoch)
        prior = p.verdict

        def leader_fn():
            evidence = self._fetch(verify_url)
            extra = self._fetch(rb_url)
            return gl.nondet.exec_prompt(
                self._judge_prompt(statement, evidence, deadline, extra),
                response_format="json",
            )

        def validator_fn(leader_res) -> bool:
            if not isinstance(leader_res, gl.vm.Return):
                return False
            leader = leader_res.calldata
            if not isinstance(leader, dict) or "verdict" not in leader:
                return False
            mine = leader_fn()
            if not isinstance(mine, dict) or "verdict" not in mine:
                return False
            return str(mine["verdict"]).upper() == str(leader["verdict"]).upper()

        result = _run_nondet(leader_fn, validator_fn)
        new_verdict = str(result.get("verdict", prior)).upper()
        if new_verdict not in ("KEPT", "BROKEN", "PARTIAL"):
            new_verdict = prior

        # The dispute bond is refunded to the challenger if their challenge
        # changed the verdict; otherwise it is forfeited into the fee pool.
        if new_verdict != prior:
            p.verdict = new_verdict
            p.reason = f"[DISPUTE CHANGED VERDICT] {str(result.get('reason',''))}"
            p.confidence = u8(max(0, min(100, int(result.get("confidence", 0)))))
            self._credit(challenger, bond)
        else:
            p.reason = f"{p.reason} | [DISPUTE REJECTED, verdict stands]"
            self.fee_pool = self.fee_pool + bond
        # extend the window slightly so others can react to the new verdict
        p.resolve_deadline = _now_epoch() + p.dispute_window_secs

    # -----------------------------------------------------------------
    # Finalize + pull payouts
    # -----------------------------------------------------------------
    @gl.public.write
    def finalize(self, pledge_id: str) -> None:
        if pledge_id not in self.pledges:
            raise gl.vm.UserError("Pledge not found")
        p = self.pledges[pledge_id]
        if p.state != "DISPUTE":
            raise gl.vm.UserError("Pledge is not awaiting finalization")
        if _now_epoch() <= p.resolve_deadline:
            raise gl.vm.UserError("Dispute window has not elapsed yet")

        total = p.stake + p.support_pool
        fee = (total * self.FEE_BPS) // bigint(10000)
        net = total - fee
        self.fee_pool = self.fee_pool + fee

        if p.verdict == "KEPT":
            self._credit(p.maker, net)
        elif p.verdict == "BROKEN":
            self._credit(p.beneficiary, net)
        else:  # PARTIAL — split between maker and beneficiary
            half = net // bigint(2)
            self._credit(p.maker, half)
            self._credit(p.beneficiary, net - half)

        p.stake = bigint(0)
        p.support_pool = bigint(0)
        p.state = "SETTLED"

    def _credit(self, addr_s: str, amount: bigint) -> None:
        key = addr_s.lower()
        cur = self.balances[key] if key in self.balances else bigint(0)
        self.balances[key] = cur + amount

    @gl.public.write
    def withdraw(self) -> None:
        key = _addr_str(gl.message.sender_address).lower()
        bal = self.balances[key] if key in self.balances else bigint(0)
        if bal <= bigint(0):
            raise gl.vm.UserError("Nothing to withdraw")
        self.balances[key] = bigint(0)
        gl.get_contract_at(gl.message.sender_address).emit_transfer(value=u256(int(bal)))

    @gl.public.write
    def withdraw_fees(self, to: Address) -> None:
        if gl.message.sender_address != self.admin:
            raise gl.vm.UserError("Only admin")
        amt = self.fee_pool
        if amt <= bigint(0):
            raise gl.vm.UserError("No fees")
        self.fee_pool = bigint(0)
        gl.get_contract_at(to).emit_transfer(value=u256(int(amt)))

    # -----------------------------------------------------------------
    # Demo seeding
    # -----------------------------------------------------------------
    @gl.public.write.payable
    def admin_seed_pledge(
        self,
        maker: str,
        title: str,
        statement: str,
        verify_url: str,
        beneficiary: str,
        deadline_epoch: int,
        dispute_window_secs: int,
    ) -> str:
        if gl.message.sender_address != self.admin:
            raise gl.vm.UserError("Only admin")
        pid_int = int(self.next_id)
        self.next_id = bigint(pid_int + 1)
        pid = str(pid_int)
        self.pledges[pid] = Pledge(
            maker=maker,
            title=title,
            statement=statement,
            verify_url=verify_url,
            beneficiary=beneficiary,
            deadline_epoch=bigint(deadline_epoch),
            dispute_window_secs=bigint(dispute_window_secs) if dispute_window_secs > 0 else self.DEFAULT_DISPUTE,
            stake=bigint(gl.message.value),
            support_pool=bigint(0),
            state="ACTIVE",
            verdict="",
            reason="",
            confidence=u8(0),
            resolve_deadline=bigint(0),
            rebuttal_url="",
            created_at=_now_epoch(),
        )
        return pid

    # -----------------------------------------------------------------
    # Views
    # -----------------------------------------------------------------
    def _pledge_json(self, pid: str, p: Pledge) -> dict:
        return {
            "pledge_id": pid,
            "maker": p.maker,
            "title": p.title,
            "statement": p.statement,
            "verify_url": p.verify_url,
            "beneficiary": p.beneficiary,
            "deadline_epoch": int(p.deadline_epoch),
            "dispute_window_secs": int(p.dispute_window_secs),
            "stake": str(p.stake),
            "support_pool": str(p.support_pool),
            "state": p.state,
            "verdict": p.verdict,
            "reason": p.reason,
            "confidence": int(p.confidence),
            "resolve_deadline": int(p.resolve_deadline),
            "rebuttal_url": p.rebuttal_url,
            "created_at": int(p.created_at),
        }

    @gl.public.view
    def get_pledge(self, pledge_id: str) -> str:
        if pledge_id not in self.pledges:
            raise gl.vm.UserError("Pledge not found")
        return json.dumps(self._pledge_json(pledge_id, self.pledges[pledge_id]))

    @gl.public.view
    def list_pledges(self, state_filter: str, offset: int, limit: int) -> str:
        total = int(self.next_id) - 1
        out = []
        start = max(1, offset + 1)
        end = min(total + 1, start + limit)
        f = state_filter.upper().strip()
        for i in range(start, end):
            k = str(i)
            if k in self.pledges:
                p = self.pledges[k]
                if not f or f == "ALL" or p.state == f:
                    out.append(self._pledge_json(k, p))
        return json.dumps(out)

    @gl.public.view
    def get_balance(self, addr: str) -> str:
        key = addr.strip().lower()
        bal = self.balances[key] if key in self.balances else bigint(0)
        return str(bal)

    @gl.public.view
    def get_stats(self) -> str:
        total = int(self.next_id) - 1
        tvl = bigint(0)
        kept = 0
        broken = 0
        for i in range(1, total + 1):
            k = str(i)
            if k in self.pledges:
                p = self.pledges[k]
                tvl = tvl + p.stake + p.support_pool
                if p.verdict == "KEPT":
                    kept += 1
                elif p.verdict == "BROKEN":
                    broken += 1
        return json.dumps({
            "total_pledges": total,
            "locked": str(tvl),
            "kept": kept,
            "broken": broken,
            "fee_pool": str(self.fee_pool),
        })
