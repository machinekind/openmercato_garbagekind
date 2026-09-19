# Podpisany kanał telemetrii edge → ERP

Endpoint `POST /api/edge/telemetry` przyjmuje wyłącznie małe, ustrukturyzowane
wyniki. Surowe klatki, nagrania, tensory i inferencja pozostają w hubie
edge/DGX; ERP otrzymuje fakty potrzebne do audytu i zarządzania.

## Koperta

```json
{
  "sessionId": "uuid sesji zwrócony przez edge connect",
  "sequence": 42,
  "timestamp": "2026-09-19T17:00:00.000Z",
  "kind": "episode",
  "payload": {
    "externalRef": "cell-a/run-20260919-000042",
    "taskKey": "sort-plastic",
    "startedAt": "2026-09-19T16:59:56.000Z",
    "endedAt": "2026-09-19T17:00:00.000Z",
    "outcome": "success",
    "metrics": { "pieces": 1 }
  },
  "signature": "base64 podpisu Ed25519"
}
```

`kind` przyjmuje `episode`, `intervention`, `detection_window`, `clip` albo
`clip_deletion_confirmation`. `clip` rejestruje tylko URI i metadane — bajty
nie przechodzą przez ERP. Przy potwierdzeniu usunięcia pole `confirmedBy` jest
wyprowadzane z klucza agenta i nie może zostać podane przez wywołującego.
Dokładne kształty ładunków publikuje OpenAPI aplikacji. `organizationId`,
`tenantId` i `robotId` są zabronione w `payload`: ERP wyprowadza je z
podpisanej sesji.

## Dane podpisywane

Agent podpisuje UTF-8 poniższego łańcucha:

```text
edge.telemetry:<sessionId>:<sequence>:<timestamp>:<kind>:<payloadSha256>
```

`payloadSha256` jest małym szesnastkowym SHA-256 kanonicznego JSON-u pola
`payload`. Kanonizacja:

1. sortuje klucze każdego obiektu leksykograficznie;
2. zachowuje kolejność tablic;
3. pomija pola o wartości `undefined` (wartość nie występuje w JSON);
4. używa standardowej reprezentacji JSON dla napisów, liczb, boolean i null;
5. odrzuca `NaN` i nieskończoność.

Rodzaj komunikatu jest częścią podpisu, więc podpisanego epizodu nie da się
przedstawić jako interwencji. Zmiana dowolnej wartości ładunku zmienia skrót.

## Kolejność i ponowienia

`sequence` jest dodatnim, stale rosnącym licznikiem wspólnym dla heartbeatów
i telemetrii w obrębie jednej sesji. ERP odrzuca numer równy lub mniejszy od
ostatniego przyjętego. Po restarcie agent otwiera nową sesję i może zacząć od
1. Znacznik czasu ma dwuminutowe okno tolerancji.

Licznik jest utrwalany dopiero po przyjęciu rekordu przez księgę domenową.
Jeżeli ERP zwróci błąd walidacji, agent może poprawić rekord i ponowić ten sam
numer. Po utracie odpowiedzi sieciowej agent może wysłać rekord ponownie;
epizody są dodatkowo idempotentne po `externalRef`, a okna detekcji po parze
kamery, czasu startu i wersji detektora.

## Prywatność

Epizod i okno detekcji nie powinny zawierać obrazu ani cech pozwalających
odtworzyć wizerunek. Podgląd konkretnej kamery jest osobnym, autoryzowanym
kanałem na żądanie; telemetria niesie jedynie agregaty i odwołania.
