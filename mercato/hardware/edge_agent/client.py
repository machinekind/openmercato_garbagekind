#!/usr/bin/env python3
"""Klient sześciu endpointów kanału brzegowego. Bez zależności poza `cryptography`.

Model jest odwrotny niż kolejka zadań: centrala publikuje stan pożądany, robot
go pobiera (`lease`) i mówi, co faktycznie robi (`report`). ERP niczego nie
zatrzymuje - endpoint, który „przerywa" zadanie, zapisuje fakt, a nie hamuje
maszynę.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from identity import Identity, fingerprint, sign  # noqa: E402
from protocol import (  # noqa: E402
    connect_payload,
    enroll_payload,
    heartbeat_payload,
    iso_timestamp,
    lease_payload,
    report_payload,
    telemetry_payload,
)

REQUEST_TIMEOUT_S = 15.0


class EdgeAgentError(RuntimeError):
    """Odmowa centrali. `status` 401 znaczy: połącz się na nowo, nie poprawiaj treści."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.message = message


class EdgeAgentClient:
    def __init__(self, identity: Identity, timeout_s: float = REQUEST_TIMEOUT_S) -> None:
        self.identity = identity
        self.timeout_s = timeout_s

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        url = f"{self.identity.base_url.rstrip('/')}{path}"
        request = urllib.request.Request(
            url,
            data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_s) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", errors="replace")
            try:
                message = json.loads(raw).get("error", raw)
            except json.JSONDecodeError:
                message = raw
            raise EdgeAgentError(error.code, message) from None

    def _sign(self, payload: str) -> str:
        return sign(self.identity.private_key_pem, payload)

    def enroll(
        self,
        token: str,
        agent_kind: str = "onboard",
        agent_version: str | None = None,
        heartbeat_interval_seconds: int = 30,
        liveness_grace_seconds: int = 30,
        lost_after_seconds: int = 300,
    ) -> dict[str, Any]:
        """Pierwszy kontakt: bilet wpisowy podpisany **nowym** kluczem.

        Podpis wiąże posiadanie biletu z posiadaniem klucza prywatnego - bez
        tego przechwycony bilet pozwoliłby wpisać dowolny własny klucz.
        """
        public_pem = self.identity.public_key_pem
        key_fingerprint = fingerprint(public_pem)
        result = self._post(
            "/api/edge/enroll",
            {
                "token": token,
                "publicKey": public_pem,
                "signature": self._sign(enroll_payload(token, key_fingerprint)),
                "agentKind": agent_kind,
                "agentVersion": agent_version,
                "heartbeatIntervalSeconds": heartbeat_interval_seconds,
                "livenessGraceSeconds": liveness_grace_seconds,
                "lostAfterSeconds": lost_after_seconds,
            },
        )
        self.identity.agent_id = result["agentId"]
        self.identity.robot_id = result["robotId"]
        self.identity.key_fingerprint = result["fingerprint"]
        self.identity.start_session(result["sessionId"])
        if result["fingerprint"] != key_fingerprint:
            raise EdgeAgentError(409, "Odcisk klucza z centrali różni się od lokalnego.")
        return result

    def connect(self, agent_version: str | None = None) -> dict[str, Any]:
        """Otwiera nową sesję po restarcie agenta i zeruje liczniki kolejności."""
        if not self.identity.agent_id:
            raise EdgeAgentError(400, "Agent nie jest wpisany - najpierw enroll.")
        timestamp = iso_timestamp()
        result = self._post(
            "/api/edge/connect",
            {
                "agentId": self.identity.agent_id,
                "timestamp": timestamp,
                "signature": self._sign(connect_payload(self.identity.agent_id, timestamp)),
                "agentVersion": agent_version,
            },
        )
        self.identity.start_session(result["sessionId"])
        return result

    def _session(self) -> str:
        if not self.identity.session_id:
            raise EdgeAgentError(400, "Brak otwartej sesji - wywołaj connect.")
        return self.identity.session_id

    def heartbeat(self) -> dict[str, Any]:
        """Uderzenie serca. Odpowiedź zawiera własny termin odcięcia robota."""
        session_id = self._session()
        sequence = self.identity.next_sequence()
        timestamp = iso_timestamp()
        return self._post(
            "/api/edge/heartbeat",
            {
                "sessionId": session_id,
                "sequence": sequence,
                "timestamp": timestamp,
                "signature": self._sign(heartbeat_payload(session_id, sequence, timestamp)),
            },
        )

    def send_telemetry(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Telemetria dzieli licznik z uderzeniami serca - centrala ma jeden na sesję."""
        session_id = self._session()
        sequence = self.identity.next_sequence()
        timestamp = iso_timestamp()
        return self._post(
            "/api/edge/telemetry",
            {
                "sessionId": session_id,
                "sequence": sequence,
                "timestamp": timestamp,
                "kind": kind,
                "payload": payload,
                "signature": self._sign(
                    telemetry_payload(session_id, sequence, timestamp, kind, payload)
                ),
            },
        )

    def request_lease(self) -> dict[str, Any]:
        """Pyta o stan pożądany. Brak przypisania to `desiredState: stopped`, nie błąd."""
        session_id = self._session()
        sequence = self.identity.next_lease_sequence()
        timestamp = iso_timestamp()
        return self._post(
            "/api/deployment/lease",
            {
                "sessionId": session_id,
                "sequence": sequence,
                "timestamp": timestamp,
                "signature": self._sign(lease_payload(session_id, sequence, timestamp)),
            },
        )

    def report_state(
        self,
        reported_state: str,
        reported_policy_version_id: str | None = None,
    ) -> dict[str, Any]:
        """Zgłasza stan faktyczny. Własny przedrostek: podpis dzierżawy tu nie przejdzie."""
        session_id = self._session()
        timestamp = iso_timestamp()
        return self._post(
            "/api/deployment/report",
            {
                "sessionId": session_id,
                "reportedState": reported_state,
                "reportedPolicyVersionId": reported_policy_version_id,
                "timestamp": timestamp,
                "signature": self._sign(report_payload(session_id, reported_state, timestamp)),
            },
        )
