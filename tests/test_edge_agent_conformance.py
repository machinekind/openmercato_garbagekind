"""Zgodność agenta z kodem centrali, sprawdzana na prawdziwych modułach TypeScript.

Test jest pomijany, gdy w środowisku nie ma Node 22+ ze wsparciem dla
`--experimental-strip-types`. Pominięcie jest świadome: brak Node nie czyni
agenta poprawnym, ale też nie jest powodem, żeby wywrócić zestaw pythona.
"""

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1]
AGENT_DIR = ROOT / "mercato" / "hardware" / "edge_agent"
CONFORMANCE = AGENT_DIR / "conformance.mts"
sys.path.insert(0, str(AGENT_DIR))


def load(name: str):
    spec = importlib.util.spec_from_file_location(f"edge_agent_{name}", AGENT_DIR / f"{name}.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


protocol = load("protocol")
identity = load("identity")


def node_supports_type_stripping() -> bool:
    if shutil.which("node") is None:
        return False
    probe = subprocess.run(
        ["node", "--experimental-strip-types", "--no-warnings", "-e", "const x: number = 1"],
        capture_output=True,
    )
    return probe.returncode == 0


@unittest.skipUnless(node_supports_type_stripping(), "Node 22+ z --experimental-strip-types niedostępny")
class ConformanceTest(unittest.TestCase):
    def build_python_side(self) -> dict:
        private_key = identity.generate_private_key_pem()
        public_key = identity.public_key_pem(private_key)
        # Liczby dobrane pod rozbieznosci JSON.stringify kontra json.dumps.
        payload = {
            "zeta": 1.0,
            "alpha": 12.4,
            "nested": {"b": [3, 2, {"y": True, "x": None}], "a": "łódź"},
            "tiny": 1e-7,
            "big": 1e21,
            "count": 9000,
            "neg": -0.0,
        }
        stamp = "2026-09-20T01:23:45.678Z"
        items = {
            "enroll": protocol.enroll_payload("tok-1", "fp-1"),
            "connect": protocol.connect_payload("agent-1", stamp),
            "heartbeat": protocol.heartbeat_payload("sess-1", 7, stamp),
            "telemetry": protocol.telemetry_payload("sess-1", 8, stamp, "episode", payload),
            "rotate": protocol.rotate_payload("agent-1", "fp-2"),
            "lease": protocol.lease_payload("sess-1", 3, stamp),
            "report": protocol.report_payload("sess-1", "running", stamp),
        }
        return {
            "timestamp": stamp,
            "publicKeyPem": public_key,
            "fingerprint": identity.fingerprint(public_key),
            "canonical": protocol.canonical_json(payload),
            "payload": payload,
            "items": items,
            "signatures": {name: identity.sign(private_key, text) for name, text in items.items()},
        }

    def test_central_modules_accept_every_signature_the_agent_produces(self):
        with tempfile.TemporaryDirectory() as directory:
            side = Path(directory) / "python-side.json"
            side.write_text(
                json.dumps(self.build_python_side(), ensure_ascii=False), encoding="utf-8"
            )
            completed = subprocess.run(
                ["node", "--experimental-strip-types", "--no-warnings", str(CONFORMANCE), str(side)],
                capture_output=True,
                text=True,
                cwd=ROOT,
            )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        report = json.loads(completed.stdout)
        failures = {key: value for key, value in report.items() if value is False}
        self.assertEqual(failures, {}, f"rozjazd z centralą: {failures}")
        self.assertTrue(report["canonicalMatches"])
        self.assertTrue(report["fingerprintMatches"])
        self.assertTrue(report["crossContextRejected"])
        for name in ("enroll", "connect", "heartbeat", "telemetry", "rotate", "lease", "report"):
            self.assertTrue(report[f"{name}.signatureVerifies"], name)


if __name__ == "__main__":
    unittest.main()
