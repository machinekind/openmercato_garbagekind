"""Lazy-loaded detector slots (spec B/E).

Four slots: people (YOLO11m/COCO), ppe, cans (YOLOE, classes baked into the
engine), hazards (YOLOE, hazard vocab). Each slot prefers a TensorRT engine
at ~/a1x-agent/engines/<slot>.engine and falls back to a .pt checkpoint in
~/a1x-agent/weights/ (YOLOE .pt fallbacks get set_classes() at load time —
engines have their prompts baked in at export).

Results are compact JSON-ready dicts: class names, integer boxes, rounded
confidences, per-class counts. Inference is blocking (Ultralytics), so the
async wrappers run it in a worker thread.
"""

import asyncio
import logging
import threading
import time
from typing import Any

import cv2
import numpy as np

from . import config

log = logging.getLogger(__name__)

_SLOT_SPECS: dict[str, dict[str, Any]] = {
    "people": {"engine": "yolo11m.engine", "weights": "yolo11m.pt",
               "classes": None},
    "ppe": {"engine": "ppe.engine", "weights": "ppe-yolo11.pt",
            "classes": None},
    "cans": {"engine": "yoloe26s-cans.engine", "weights": "yoloe-26s-seg.pt",
             "classes": ["beverage can", "soda can"]},
    "hazards": {"engine": "yoloe26s-hazards.engine",
                "weights": "yoloe-26s-seg.pt",
                "classes": ["fire", "smoke", "spill", "exposed wire",
                            "ladder"]},
    "faces": {"engine": "faces.engine", "weights": "yolov8n-face.pt",
              "classes": None},
}

MODELS = tuple(_SLOT_SPECS)

_models: dict[str, Any] = {}
_load_lock = threading.Lock()


class DetectorError(Exception):
    """A detector slot could not be loaded or run."""


def _load_slot(slot: str):
    """Load one slot (engine preferred, .pt fallback). Called under lock."""
    try:
        import ultralytics  # noqa: F401 — availability probe only
    except ImportError:
        raise DetectorError(
            "detectors offline: ultralytics/torch still installing — "
            "answer from what you can SEE in the camera views instead")
    spec = _SLOT_SPECS[slot]
    engine_path = config.ENGINES_DIR / spec["engine"]
    weights_path = config.WEIGHTS_DIR / spec["weights"]

    if engine_path.is_file():
        from ultralytics import YOLO
        log.info("detector %s: loading TRT engine %s", slot, engine_path)
        return YOLO(str(engine_path), task="detect")

    if not weights_path.is_file():
        raise DetectorError(
            f"detector {slot!r}: neither {engine_path} nor {weights_path} "
            "exists (run scripts/export_engines.py or drop weights)")

    if spec["classes"] is not None:
        from ultralytics import YOLOE
        log.info("detector %s: loading YOLOE weights %s (open-vocab %s)",
                 slot, weights_path, spec["classes"])
        model = YOLOE(str(weights_path))
        model.set_classes(spec["classes"],
                          model.get_text_pe(spec["classes"]))
        return model

    from ultralytics import YOLO
    log.info("detector %s: loading weights %s", slot, weights_path)
    return YOLO(str(weights_path))


def _get_model(slot: str):
    if slot not in _SLOT_SPECS:
        raise DetectorError(f"unknown detector slot {slot!r}")
    with _load_lock:
        if slot not in _models:
            _models[slot] = _load_slot(slot)
        return _models[slot]


def _run_sync(slot: str, bgr: np.ndarray, conf: float) -> dict[str, Any]:
    model = _get_model(slot)
    t0 = time.monotonic()
    try:
        results = model.predict(bgr, conf=conf, verbose=False)
    except Exception as exc:  # ultralytics raises many concrete types
        raise DetectorError(f"detector {slot!r} inference failed: {exc}") \
            from exc
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    boxes_out: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    if results:
        result = results[0]
        names = result.names or {}
        if result.boxes is not None:
            for box in result.boxes:
                cls_id = int(box.cls.item())
                # Normalize hyphenated class names (e.g. the interim HF PPE
                # model's "no-helmet") to snake_case so downstream filters
                # match one spelling.
                name = str(names.get(cls_id, cls_id)).replace("-", "_")
                xyxy = [int(v) for v in box.xyxy[0].tolist()]
                boxes_out.append({
                    "cls": name,
                    "conf": round(float(box.conf.item()), 2),
                    "xyxy": xyxy,
                })
                counts[name] = counts.get(name, 0) + 1
    return {
        "model": slot,
        "counts": counts,
        "total": len(boxes_out),
        "boxes": boxes_out,
        "ms": elapsed_ms,
    }


async def detect(slot: str, bgr: np.ndarray,
                 conf: float = 0.25) -> dict[str, Any]:
    """Async detector run; returns the compact result dict."""
    return await asyncio.to_thread(_run_sync, slot, bgr, conf)


def annotate(bgr: np.ndarray, result: dict[str, Any]) -> bytes:
    """Draw boxes/labels on a copy of the frame; return JPEG bytes."""
    canvas = bgr.copy()
    for box in result.get("boxes", []):
        x1, y1, x2, y2 = box["xyxy"]
        label = f'{box["cls"]} {box["conf"]:.2f}'
        cv2.rectangle(canvas, (x1, y1), (x2, y2), (0, 200, 255), 2)
        cv2.putText(canvas, label, (x1, max(0, y1 - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 200, 255), 2)
    ok, jpeg = cv2.imencode(
        ".jpg", canvas,
        [cv2.IMWRITE_JPEG_QUALITY, config.ROBOT_CAM_JPEG_QUALITY])
    if not ok:
        raise DetectorError("annotate: JPEG encode failed")
    return jpeg.tobytes()
