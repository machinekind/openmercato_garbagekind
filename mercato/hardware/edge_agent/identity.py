#!/usr/bin/env python3
"""Tożsamość agenta: klucz Ed25519 i stan sesji, trzymane na robocie.

Klucz prywatny **nigdy nie opuszcza tej maszyny**. Centrala zna wyłącznie
publiczny, więc wyciek jej bazy nie pozwala podszyć się pod robota. Z tego
samego powodu plik tożsamości zakładamy z prawami 0600 i nie logujemy jego
zawartości - ani w całości, ani fragmentami.

Odcisk klucza liczymy z postaci DER/SPKI, nie z tekstu PEM: ten sam klucz
zapisany z innymi końcami wierszy dałby inny skrót tekstowy, a operator
porównujący odcisk z ekranu robota zobaczyłby rozbieżność tam, gdzie jej nie ma.
"""

from __future__ import annotations

import base64
import dataclasses
import hashlib
import json
import os
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

IDENTITY_FILE_MODE = 0o600
DEFAULT_IDENTITY_PATH = Path(".runtime/edge-agent/identity.json")


def generate_private_key_pem() -> str:
    key = Ed25519PrivateKey.generate()
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")


def public_key_pem(private_key_pem: str) -> str:
    key = serialization.load_pem_private_key(private_key_pem.encode("ascii"), password=None)
    return key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")


def fingerprint(public_key_pem_text: str) -> str:
    """SHA-256 klucza publicznego w postaci DER/SPKI, zapis szesnastkowy."""
    key = serialization.load_pem_public_key(public_key_pem_text.encode("ascii"))
    der = key.public_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    return hashlib.sha256(der).hexdigest()


def sign(private_key_pem: str, payload: str) -> str:
    key = serialization.load_pem_private_key(private_key_pem.encode("ascii"), password=None)
    return base64.b64encode(key.sign(payload.encode("utf-8"))).decode("ascii")


@dataclasses.dataclass
class Identity:
    """Stan agenta między uruchomieniami procesu.

    `sequence` jest wspólny dla uderzeń serca i telemetrii, bo centrala trzyma
    jeden licznik na sesję. `lease_sequence` jest osobny - dzierżawy mają własny
    licznik po stronie centrali i mieszanie ich kończy się odrzuceniem żądania.
    """

    base_url: str
    private_key_pem: str
    agent_id: str | None = None
    robot_id: str | None = None
    session_id: str | None = None
    key_fingerprint: str | None = None
    sequence: int = 0
    lease_sequence: int = 0

    @property
    def public_key_pem(self) -> str:
        return public_key_pem(self.private_key_pem)

    def next_sequence(self) -> int:
        self.sequence += 1
        return self.sequence

    def next_lease_sequence(self) -> int:
        self.lease_sequence += 1
        return self.lease_sequence

    def start_session(self, session_id: str) -> None:
        """Nowa sesja zeruje oba liczniki - centrala liczy je per sesja, nie globalnie."""
        self.session_id = session_id
        self.sequence = 0
        self.lease_sequence = 0

    def redacted(self) -> dict[str, Any]:
        """Postać nadająca się do wypisania: bez klucza prywatnego."""
        return {
            "baseUrl": self.base_url,
            "agentId": self.agent_id,
            "robotId": self.robot_id,
            "sessionId": self.session_id,
            "keyFingerprint": self.key_fingerprint,
            "sequence": self.sequence,
            "leaseSequence": self.lease_sequence,
        }


def load_identity(path: Path) -> Identity:
    data = json.loads(path.read_text(encoding="utf-8"))
    return Identity(
        base_url=data["baseUrl"],
        private_key_pem=data["privateKeyPem"],
        agent_id=data.get("agentId"),
        robot_id=data.get("robotId"),
        session_id=data.get("sessionId"),
        key_fingerprint=data.get("keyFingerprint"),
        sequence=int(data.get("sequence", 0)),
        lease_sequence=int(data.get("leaseSequence", 0)),
    )


def save_identity(path: Path, identity: Identity) -> None:
    """Zapis atomowy z prawami 0600 nadanymi przed wpisaniem klucza."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "baseUrl": identity.base_url,
        "privateKeyPem": identity.private_key_pem,
        "agentId": identity.agent_id,
        "robotId": identity.robot_id,
        "sessionId": identity.session_id,
        "keyFingerprint": identity.key_fingerprint,
        "sequence": identity.sequence,
        "leaseSequence": identity.lease_sequence,
    }
    temporary = path.with_suffix(path.suffix + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, IDENTITY_FILE_MODE)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")
    os.chmod(temporary, IDENTITY_FILE_MODE)
    temporary.replace(path)
