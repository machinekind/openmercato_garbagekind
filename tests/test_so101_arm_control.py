import importlib.util
import random
import sys
import unittest
from pathlib import Path


MODULE_DIR = Path(__file__).parents[1] / "mercato" / "hardware" / "so101"
sys.path.insert(0, str(MODULE_DIR))
SPEC = importlib.util.spec_from_file_location("so101_arm_control", MODULE_DIR / "arm_control.py")
assert SPEC and SPEC.loader
arm = importlib.util.module_from_spec(SPEC)
# Dataklasy wymagaja modulu w sys.modules przed wykonaniem.
sys.modules[SPEC.name] = arm
SPEC.loader.exec_module(arm)


class WindowTest(unittest.TestCase):
    def test_window_shrinks_eeprom_limits_by_margin(self):
        window = arm.build_window("shoulder_pan", 1, 836, 2794)

        self.assertEqual(window.soft_min, 836 + arm.SOFT_LIMIT_MARGIN_TICKS)
        self.assertEqual(window.soft_max, 2794 - arm.SOFT_LIMIT_MARGIN_TICKS)

    def test_narrow_range_keeps_window_non_empty(self):
        window = arm.build_window("gripper", 6, 2000, 2010)

        self.assertLess(window.soft_min, window.soft_max)

    def test_inconsistent_limits_are_rejected(self):
        with self.assertRaises(ValueError):
            arm.build_window("elbow_flex", 3, 3000, 3000)

    def test_gripper_gets_its_own_smaller_delta(self):
        gripper = arm.build_window("gripper", 6, 2044, 3499)
        elbow = arm.build_window("elbow_flex", 3, 1540, 3609)

        self.assertEqual(gripper.max_delta, arm.GRIPPER_MAX_DELTA_TICKS)
        self.assertEqual(elbow.max_delta, arm.MAX_DELTA_TICKS)

    def test_clamp_keeps_value_inside_window(self):
        window = arm.build_window("wrist_roll", 5, 0, 4095)

        self.assertEqual(window.clamp(-500), window.soft_min)
        self.assertEqual(window.clamp(9000), window.soft_max)
        self.assertEqual(window.clamp(2000), 2000)


class RandomTargetTest(unittest.TestCase):
    def windows(self):
        limits = {
            "shoulder_pan": (836, 2794),
            "shoulder_lift": (1122, 3504),
            "elbow_flex": (1540, 3609),
            "wrist_flex": (961, 3313),
            "wrist_roll": (0, 4095),
            "gripper": (2044, 3499),
        }
        return {
            name: arm.build_window(name, motor_id, *limits[name])
            for name, motor_id in arm.JOINTS
        }

    def test_target_never_leaves_window_nor_exceeds_delta(self):
        windows = self.windows()
        current = {name: window.soft_min for name, window in windows.items()}
        rng = random.Random(7)

        for _ in range(200):
            targets = arm.plan_random_targets(current, windows, rng)
            for name, value in targets.items():
                window = windows[name]
                self.assertGreaterEqual(value, window.soft_min)
                self.assertLessEqual(value, window.soft_max)
                self.assertLessEqual(abs(value - current[name]), window.max_delta)
            current = targets

    def test_position_outside_window_is_pulled_back_before_planning(self):
        windows = self.windows()
        # Ramię zastane oparte o limit — pozycja poza zawężonym okienkiem.
        current = {name: 0 for name in windows}
        targets = arm.plan_random_targets(current, windows, random.Random(1))

        for name, value in targets.items():
            self.assertGreaterEqual(value, windows[name].soft_min)

    def test_planning_can_be_restricted_to_selected_joints(self):
        windows = self.windows()
        current = {name: window.soft_min + 10 for name, window in windows.items()}

        targets = arm.plan_random_targets(current, windows, random.Random(3), joints=["wrist_roll"])

        self.assertEqual(list(targets), ["wrist_roll"])

    def test_same_seed_gives_same_pose(self):
        windows = self.windows()
        current = {name: window.soft_min + 200 for name, window in windows.items()}

        first = arm.plan_random_targets(current, windows, random.Random(42))
        second = arm.plan_random_targets(current, windows, random.Random(42))

        self.assertEqual(first, second)


class HealthGateTest(unittest.TestCase):
    def reading(self, **overrides):
        base = {"voltageDecivolt": 118, "temperatureC": 30, "load": 0}
        base.update(overrides)
        return {"shoulder_pan": base}

    def test_healthy_bus_passes(self):
        healthy, problems = arm.evaluate_health(self.reading())

        self.assertTrue(healthy)
        self.assertEqual(problems, [])

    def test_undervoltage_blocks_motion(self):
        healthy, problems = arm.evaluate_health(self.reading(voltageDecivolt=48))

        self.assertFalse(healthy)
        self.assertIn("napięcie", problems[0])

    def test_overtemperature_blocks_motion(self):
        healthy, problems = arm.evaluate_health(self.reading(temperatureC=61))

        self.assertFalse(healthy)
        self.assertIn("temperatura", problems[0])

    def test_overload_blocks_motion(self):
        healthy, problems = arm.evaluate_health(self.reading(load=-1500))

        self.assertFalse(healthy)
        self.assertIn("obciążenie", problems[0])

    def test_missing_reading_is_not_treated_as_healthy(self):
        healthy, problems = arm.evaluate_health({"gripper": {}})

        self.assertFalse(healthy)
        self.assertEqual(len(problems), 2)


class MoveGuardTest(unittest.TestCase):
    def test_move_without_torque_is_refused(self):
        arm_session = arm.ArmSession.__new__(arm.ArmSession)
        arm_session.torque_enabled = False

        result = arm.ArmSession.move_to(arm_session, {"wrist_roll": 2000})

        self.assertEqual(result["status"], "refused")

    def test_ticks_convert_to_degrees(self):
        self.assertEqual(arm.ticks_to_degrees(arm.TICKS_PER_TURN), 360.0)
        self.assertEqual(arm.ticks_to_degrees(0), 0.0)


if __name__ == "__main__":
    unittest.main()


class DemoScopeTest(unittest.TestCase):
    def windows(self):
        limits = {
            "shoulder_pan": (836, 2794),
            "shoulder_lift": (1122, 3504),
            "elbow_flex": (1540, 3609),
            "wrist_flex": (961, 3313),
            "wrist_roll": (0, 4095),
            "gripper": (2044, 3499),
        }
        return {
            name: arm.build_window(name, motor_id, *limits[name])
            for name, motor_id in arm.JOINTS
        }

    def test_demo_delta_stays_within_requested_degrees(self):
        windows = self.windows()
        current = {name: 2000 for name in windows}
        budget = arm.degrees_to_ticks(arm.DEMO_DELTA_DEG)
        rng = random.Random(11)

        for _ in range(100):
            targets = arm.plan_random_targets(
                current, windows, rng, joints=arm.DEMO_JOINTS, delta_ticks=budget
            )
            self.assertEqual(set(targets), set(arm.DEMO_JOINTS))
            for name, value in targets.items():
                self.assertLessEqual(abs(value - current[name]), budget)

    def test_delta_override_cannot_widen_joint_budget(self):
        windows = self.windows()
        # Pozycja wewnatrz zawezonego okna, zeby mierzyc sam przyrost.
        current = {name: 2500 for name in windows}

        targets = arm.plan_random_targets(
            current, windows, random.Random(5), joints=["gripper"], delta_ticks=4000
        )

        self.assertLessEqual(
            abs(targets["gripper"] - current["gripper"]), windows["gripper"].max_delta
        )

    def test_degrees_and_ticks_round_trip(self):
        self.assertEqual(arm.degrees_to_ticks(360.0), arm.TICKS_PER_TURN)
        self.assertAlmostEqual(arm.ticks_to_degrees(arm.degrees_to_ticks(30.0)), 30.0, places=1)


class ReleaseTest(unittest.TestCase):
    def session_with_home(self, home, torque_enabled=True):
        session = arm.ArmSession.__new__(arm.ArmSession)
        session.torque_enabled = torque_enabled
        session.home_position = home
        session.calls = []
        session.released = {}

        def move_to(targets, timeout_s=arm.MOVE_TIMEOUT_S, clamp=True):
            session.calls.append({"targets": dict(targets), "clamp": clamp})
            return {"status": "reached", "targetPositionRaw": dict(targets)}

        def write(register, joint, value):
            session.released[joint] = value

        def read(register, joint):
            return 0

        session.move_to = move_to
        session._write = write
        session._read = read
        session.read_positions = lambda: dict(home or {})
        return session

    def test_release_returns_to_captured_pose_before_cutting_torque(self):
        home = {name: 1500 for name, _ in arm.JOINTS}
        session = self.session_with_home(home)

        result = arm.ArmSession.release(session)

        self.assertEqual(session.calls, [{"targets": home, "clamp": False}])
        self.assertEqual(result["returnHome"]["status"], "reached")
        self.assertEqual(result["status"], "released")
        self.assertEqual(set(session.released), {name for name, _ in arm.JOINTS})

    def test_release_without_return_home_skips_the_move(self):
        home = {name: 1500 for name, _ in arm.JOINTS}
        session = self.session_with_home(home)

        result = arm.ArmSession.release(session, return_home=False)

        self.assertEqual(session.calls, [])
        self.assertIsNone(result["returnHome"])

    def test_release_without_captured_pose_still_cuts_torque(self):
        session = self.session_with_home(None)

        result = arm.ArmSession.release(session)

        self.assertEqual(session.calls, [])
        self.assertEqual(result["status"], "released")

    def test_return_home_does_not_clamp_the_captured_pose(self):
        # Poza zastana moze lezec poza zawezonym oknem; powrot musi trafic w nia.
        home = {name: 1126 for name, _ in arm.JOINTS}
        session = self.session_with_home(home)

        arm.ArmSession.return_home(session)

        self.assertEqual(session.calls[0]["clamp"], False)
        self.assertEqual(session.calls[0]["targets"], home)

    def test_return_home_is_refused_without_captured_pose(self):
        session = self.session_with_home(None)

        result = arm.ArmSession.return_home(session)

        self.assertEqual(result["status"], "refused")
