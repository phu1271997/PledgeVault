"""PledgeVault — happy path + adversarial / edge-case tests.

Deterministic paths run without a live LLM; the resolve() test installs LLM +
web mocks first (R17) so the nondet consensus transaction finalizes.
"""
import json

import pytest
from gltest import get_contract_factory

GEN = 10**18
FUTURE = 4102444800   # 2100-01-01, comfortably in the future
PAST = 1000000000     # 2001, comfortably in the past
VERIFY = "https://github.com/example/promise/releases/tag/v1.0"


def _deploy(admin):
    return get_contract_factory("Contract").deploy(account=admin)


def _install_mocks(contract, verdict="KEPT", confidence=90):
    payload = json.dumps({"verdict": verdict, "confidence": confidence,
                          "reason": "Mocked arbiter verdict for tests."})
    try:
        contract.provider.make_request(
            method="sim_installMocks",
            params={
                "llm_mocks": {".*": payload},
                "web_mocks": {".*": {"status": 200, "body": "Release v1.0 shipped on time."}},
            },
        )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------
def test_create_pledge_and_view(admin, maker):
    c = _deploy(admin)
    pid = c.connect(maker).create_pledge(
        args=["Ship v1.0", "I will publish a tagged v1.0 release of my library by the deadline.",
              VERIFY, maker.address, FUTURE, 60]
    ).transact(value=2 * GEN)
    pledges = json.loads(c.list_pledges(args=["ALL", 0, 10]).call())
    assert len(pledges) == 1
    assert pledges[0]["title"] == "Ship v1.0"
    assert pledges[0]["state"] == "ACTIVE"
    assert int(pledges[0]["stake"]) == 2 * GEN


def test_back_pledge_grows_pool(admin, maker, backer):
    c = _deploy(admin)
    pid = c.connect(maker).create_pledge(
        args=["Ship v1.0", "I will publish a tagged v1.0 release by the deadline.",
              VERIFY, maker.address, FUTURE, 60]
    ).transact(value=2 * GEN)
    c.connect(backer).back_pledge(args=[str(pid)]).transact(value=3 * GEN)
    p = json.loads(c.get_pledge(args=[str(pid)]).call())
    assert int(p["support_pool"]) == 3 * GEN


# ---------------------------------------------------------------------------
# Edge cases / adversarial
# ---------------------------------------------------------------------------
def test_stake_below_minimum_rejected(admin, maker):
    c = _deploy(admin)
    with pytest.raises(Exception):
        c.connect(maker).create_pledge(
            args=["x", "I will do the thing eventually maybe.", VERIFY,
                  maker.address, FUTURE, 60]
        ).transact(value=1 * GEN)  # < 2 GEN


def test_deadline_in_past_rejected(admin, maker):
    c = _deploy(admin)
    with pytest.raises(Exception):
        c.connect(maker).create_pledge(
            args=["late", "I promise to have done this already in the past.",
                  VERIFY, maker.address, PAST, 60]
        ).transact(value=2 * GEN)


def test_resolve_before_deadline_reverts(admin, maker):
    c = _deploy(admin)
    pid = c.connect(maker).create_pledge(
        args=["future", "I will ship a v1.0 release by the far-future deadline.",
              VERIFY, maker.address, FUTURE, 60]
    ).transact(value=2 * GEN)
    with pytest.raises(Exception):
        c.connect(maker).resolve(args=[str(pid)]).transact()


def test_withdraw_nothing_reverts(admin, backer):
    c = _deploy(admin)
    with pytest.raises(Exception):
        c.connect(backer).withdraw().transact()


# ---------------------------------------------------------------------------
# Consensus resolve (mocked) — uses a past-deadline seeded pledge
# ---------------------------------------------------------------------------
def test_resolve_sets_verdict(admin, maker):
    c = _deploy(admin)
    _install_mocks(c, verdict="KEPT", confidence=90)
    # admin-seed a pledge whose deadline is already past so resolve() is allowed
    pid = c.connect(admin).admin_seed_pledge(
        args=[maker.address, "Ship v1.0",
              "I will publish a tagged v1.0 release.", VERIFY,
              maker.address, PAST, 60]
    ).transact(value=2 * GEN)
    c.connect(maker).resolve(args=[str(pid)]).transact()
    p = json.loads(c.get_pledge(args=[str(pid)]).call())
    assert p["verdict"] == "KEPT"
    assert p["state"] == "DISPUTE"
