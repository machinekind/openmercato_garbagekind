/**
 * Porównanie pythonowego agenta z prawdziwym kodem centrali.
 *
 * Testy pythona sprawdzają wyłącznie, czy agent zgadza się sam ze sobą. To za
 * mało: rozjazd kanonicznego JSON-u albo przedrostka objawia się dopiero jako
 * „podpis nieprawidłowy" na produkcji, bez wskazania przyczyny. Dlatego ten
 * plik ładuje `edge/lib/crypto.ts` i `deployment/lib/protocol.ts` - te same
 * moduły, których używa serwer - i weryfikuje podpisy złożone przez agenta.
 *
 * Uruchomienie (Node 22+, bez budowania):
 *
 *     node --experimental-strip-types mercato/hardware/edge_agent/conformance.mts <plik.json>
 *
 * Plik wejściowy produkuje `tests/test_edge_agent_conformance.py`.
 */

import { readFileSync } from 'node:fs'
import { canonicalJson, payloads, fingerprintPublicKey, verifyPayloadSignature } from '../../modules/edge/lib/crypto.ts'
import { leasePayload, reportPayload } from '../../modules/deployment/lib/protocol.ts'

type PythonSide = {
  timestamp: string
  publicKeyPem: string
  fingerprint: string
  canonical: string
  payload: unknown
  items: Record<string, string>
  signatures: Record<string, string>
}

const side = JSON.parse(readFileSync(process.argv[2], 'utf8')) as PythonSide
const ts = side.timestamp

const central: Record<string, string> = {
  enroll: payloads.enroll('tok-1', 'fp-1'),
  connect: payloads.connect('agent-1', ts),
  heartbeat: payloads.heartbeat('sess-1', 7, ts),
  telemetry: payloads.telemetry('sess-1', 8, ts, 'episode', side.payload),
  rotate: payloads.rotate('agent-1', 'fp-2'),
  lease: leasePayload('sess-1', 3, ts),
  report: reportPayload('sess-1', 'running', ts),
}

const report: Record<string, unknown> = {
  canonicalMatches: canonicalJson(side.payload) === side.canonical,
  canonicalCentral: canonicalJson(side.payload),
  fingerprintMatches: fingerprintPublicKey(side.publicKeyPem) === side.fingerprint,
}

for (const [name, text] of Object.entries(central)) {
  report[`${name}.textMatches`] = text === side.items[name]
  report[`${name}.signatureVerifies`] = verifyPayloadSignature(text, side.signatures[name], side.publicKeyPem)
}

/** Wiązanie kontekstu: podpis heartbeatu nie może przejść jako dzierżawa. */
report['crossContextRejected'] = !verifyPayloadSignature(
  central.lease,
  side.signatures.heartbeat,
  side.publicKeyPem,
)

process.stdout.write(JSON.stringify(report))
