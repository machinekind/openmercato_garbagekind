#!/usr/bin/env python3
"""Agent referencyjny SO-101 ↔ ERP. Uruchamiany na komputerze przy robocie.

Kolejność, w której ma to sens:

    init      raz na maszynę: generuje klucz Ed25519
    enroll    raz na robota: wymienia bilet wpisowy na tożsamość agenta
    connect   po każdym restarcie: otwiera nową sesję
    run       praca: uderzenia serca, dzierżawa, zgłoszenie stanu
    push      eksport dziennika ruchu SO-101 jako epizody i interwencje

Klucz prywatny zostaje w pliku tożsamości (domyślnie `.runtime/edge-agent/`)
z prawami 0600 i nigdzie nie jest wypisywany.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from client import EdgeAgentClient, EdgeAgentError  # noqa: E402
from identity import (  # noqa: E402
    DEFAULT_IDENTITY_PATH,
    Identity,
    fingerprint,
    generate_private_key_pem,
    load_identity,
    save_identity,
)
from journal import episode_from_entry, intervention_from_entry, read_journal  # noqa: E402

AGENT_VERSION = "mercato-so101-reference/1.0.0"
DEFAULT_JOURNAL = Path(".runtime/so101-motion/journal.ndjson")


def show(label: str, value: Any) -> None:
    print(f"{label}: {json.dumps(value, ensure_ascii=False, default=str)}")


def command_init(args: argparse.Namespace) -> int:
    if args.identity.exists() and not args.force:
        raise SystemExit(f"Tożsamość już istnieje: {args.identity} (użyj --force, aby nadpisać)")
    identity = Identity(base_url=args.base_url, private_key_pem=generate_private_key_pem())
    save_identity(args.identity, identity)
    print(f"Klucz prywatny zapisany z prawami 0600: {args.identity}")
    show("odcisk klucza (porównaj z ekranem w ERP)", fingerprint(identity.public_key_pem))
    return 0


def with_identity(args: argparse.Namespace) -> tuple[Identity, EdgeAgentClient]:
    identity = load_identity(args.identity)
    if args.base_url:
        identity.base_url = args.base_url
    return identity, EdgeAgentClient(identity)


def command_enroll(args: argparse.Namespace) -> int:
    identity, client = with_identity(args)
    result = client.enroll(args.token, agent_version=AGENT_VERSION)
    save_identity(args.identity, identity)
    show("wpisany", result)
    return 0


def command_connect(args: argparse.Namespace) -> int:
    identity, client = with_identity(args)
    result = client.connect(agent_version=AGENT_VERSION)
    save_identity(args.identity, identity)
    show("sesja", result)
    return 0


def command_status(args: argparse.Namespace) -> int:
    identity = load_identity(args.identity)
    show("tożsamość", identity.redacted())
    return 0


def command_run(args: argparse.Namespace) -> int:
    """Pętla pracy: serce, dzierżawa, zgłoszenie stanu.

    Zgłaszamy `stopped`, dopóki centrala nie każe czegoś innego — robot bez
    przypisania to normalny stan świeżo uruchomionej maszyny, a nie awaria.
    """
    identity, client = with_identity(args)
    reported = "stopped"
    try:
        for beat in range(1, args.beats + 1):
            heartbeat = client.heartbeat()
            line = {"beat": beat, "sequence": heartbeat["sequence"], "state": heartbeat["state"]}
            if beat == 1 or beat % args.lease_every == 0:
                lease = client.request_lease()
                reported = "running" if lease["desiredState"] == "running" else "stopped"
                line["desiredState"] = lease["desiredState"]
                line["leaseExpiryBehavior"] = lease["leaseExpiryBehavior"]
                report = client.report_state(reported, lease["policyVersionId"])
                line["reconciliation"] = report["reconciliation"]
            show("praca", line)
            save_identity(args.identity, identity)
            if beat < args.beats:
                time.sleep(args.interval)
    finally:
        save_identity(args.identity, identity)
    return 0


def command_push(args: argparse.Namespace) -> int:
    """Wysyła dziennik ruchu SO-101 jako epizody; `externalRef` chroni przed duplikatem."""
    identity, client = with_identity(args)
    episodes = 0
    interventions = 0
    skipped = 0
    try:
        for entry in read_journal(args.journal):
            episode = episode_from_entry(entry)
            if episode is None:
                skipped += 1
                continue
            result = client.send_telemetry("episode", episode)
            episodes += 1
            intervention = intervention_from_entry(entry)
            if intervention is not None:
                episode_id = (result.get("result") or {}).get("id")
                client.send_telemetry("intervention", {**intervention, "episodeId": episode_id})
                interventions += 1
            if args.limit and episodes >= args.limit:
                break
    finally:
        save_identity(args.identity, identity)
    show("wysłane", {"episodes": episodes, "interventions": interventions, "skipped": skipped})
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--identity", type=Path, default=DEFAULT_IDENTITY_PATH)
    root.add_argument("--base-url", default=None, help="np. http://localhost:3000")
    commands = root.add_subparsers(dest="command", required=True)

    init = commands.add_parser("init", help="Generate the agent key pair")
    init.add_argument("--base-url", required=True)
    init.add_argument("--force", action="store_true")

    enroll = commands.add_parser("enroll", help="Exchange an enrollment ticket for an identity")
    enroll.add_argument("--token", required=True)

    commands.add_parser("connect", help="Open a new session after a restart")
    commands.add_parser("status", help="Print the stored identity without the private key")

    run = commands.add_parser("run", help="Heartbeat, lease and state report loop")
    run.add_argument("--beats", type=int, default=100)
    run.add_argument("--interval", type=float, default=30.0)
    run.add_argument("--lease-every", type=int, default=10)

    push = commands.add_parser("push", help="Send the SO-101 motion journal as episodes")
    push.add_argument("--journal", type=Path, default=DEFAULT_JOURNAL)
    push.add_argument("--limit", type=int, default=0)
    return root


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    handler = {
        "init": command_init,
        "enroll": command_enroll,
        "connect": command_connect,
        "status": command_status,
        "run": command_run,
        "push": command_push,
    }[args.command]
    try:
        return handler(args)
    except EdgeAgentError as error:
        print(f"ODMOWA {error}", file=sys.stderr)
        return 1
    except FileNotFoundError:
        print(f"Brak tożsamości: {args.identity}. Uruchom najpierw `init`.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
