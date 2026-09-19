import asyncio

from fakes import FakeArm, FakePolicy, FakeSink
from om_bridge import main as main_mod
from om_bridge.config import BridgeConfig
from om_bridge.types import PickTask, TaskStatus

CFG = BridgeConfig(
    om_base_url="https://erp.example",
    om_api_key="secret",
    cell_id="cell-1",
    panel_base_url="http://10.42.0.1:8080",
    policy_url=None,
    poll_interval_s=0.01,
    goal_timeout_s=0.0,
    home_preset="home",
    search_preset="table",
)


def scripted(policy):
    # The `preset` policy plans no joint chunk, so the loop never needs a
    # camera - which is the point of having it.
    policy.is_scripted = True
    return policy


def patch_transports(monkeypatch, arm, sink, policy):
    monkeypatch.setattr(main_mod, "PanelArm", lambda *a, **k: arm)
    monkeypatch.setattr(main_mod, "OpenMercatoClient", lambda *a, **k: sink)
    monkeypatch.setattr(main_mod, "PresetPolicy", lambda *a, **k: policy)


async def test_loop_claims_runs_and_finishes_then_idles(monkeypatch):
    task = PickTask(id="t-1", cell_id="cell-1", instruction="pick up the can")
    arm = FakeArm(grip={"measured": 0.01, "effort": 6.45})
    arm.connect = _noop
    arm.close = _noop
    arm.check_role = _role
    sink = FakeSink([task])
    patch_transports(monkeypatch, arm, sink, scripted(FakePolicy([[]])))

    stop = asyncio.Event()
    runner = asyncio.create_task(main_mod.run_forever(CFG, "preset", stop))
    for _ in range(50):
        await asyncio.sleep(0.01)
        if sink.finished:
            break
    stop.set()
    await asyncio.wait_for(runner, timeout=2)

    assert [r.status for r in sink.finished] == [TaskStatus.SUCCEEDED]


async def test_a_failing_setup_is_reported_not_crashed(monkeypatch):
    task = PickTask(id="t-2", cell_id="cell-1", instruction="pick up the can")
    arm = FakeArm()

    async def boom():
        raise RuntimeError("panel unreachable")

    arm.connect = boom
    arm.close = _noop
    arm.check_role = _role
    sink = FakeSink([task])
    patch_transports(monkeypatch, arm, sink, scripted(FakePolicy([[]])))

    stop = asyncio.Event()
    runner = asyncio.create_task(main_mod.run_forever(CFG, "preset", stop))
    for _ in range(50):
        await asyncio.sleep(0.01)
        if sink.finished:
            break
    stop.set()
    await asyncio.wait_for(runner, timeout=2)

    assert sink.finished[0].status is TaskStatus.FAILED
    assert "panel unreachable" in sink.finished[0].detail


async def _noop():
    return None


async def _role():
    return "operator"
