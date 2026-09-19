"""Camera ownership (spec C, Option 2 pure-Python path).

Robot cam: the agent owns DGX /dev/video0. OpenCV VideoCapture, MJPG
1280x720@30. Each grabbed frame is JPEG-encoded into a latest-frame slot
and pushed outbound over raw TCP to the panel's listener at
10.42.0.1:8097 (concatenated SOI..EOI bytes). The push is non-blocking:
when the socket would block, whole frames are dropped so a stalled
laptop link never back-pressures the capture loop.

Side cam: the panel keeps owning the laptop cam; the agent reads
GET /stream/pc as a multipart MJPEG stream and keeps only the latest frame.
"""

import asyncio
import logging
import socket
import threading
import time

import aiohttp
import cv2
import numpy as np

from . import config

log = logging.getLogger(__name__)

_SOI = b"\xff\xd8"
_EOI = b"\xff\xd9"


class FrameSlot:
    """Thread-safe latest-frame slot: JPEG bytes + decoded BGR + timestamp."""

    def __init__(self, name: str):
        self.name = name
        self._lock = threading.Lock()
        self._jpeg: bytes | None = None
        self._bgr: np.ndarray | None = None
        self._t: float = 0.0

    def update(self, jpeg: bytes, bgr: np.ndarray | None = None) -> None:
        with self._lock:
            self._jpeg = jpeg
            self._bgr = bgr
            self._t = time.time()

    def get_jpeg(self) -> tuple[bytes | None, float]:
        with self._lock:
            return self._jpeg, self._t

    def get_bgr(self) -> tuple[np.ndarray | None, float]:
        with self._lock:
            if self._bgr is not None:
                return self._bgr, self._t
            if self._jpeg is None:
                return None, 0.0
            jpeg, t = self._jpeg, self._t
        arr = np.frombuffer(jpeg, dtype=np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if bgr is None:
            log.warning("%s: failed to decode latest JPEG", self.name)
            return None, 0.0
        return bgr, t

    @property
    def age_s(self) -> float:
        with self._lock:
            return time.time() - self._t if self._t else float("inf")


def reencode_jpeg_max_edge(
    jpeg: bytes,
    max_edge: int = config.IMAGE_MAX_LONG_EDGE,
    quality: int = config.ROBOT_CAM_JPEG_QUALITY,
) -> bytes:
    """Re-encode a JPEG so its long edge is <= max_edge (spec E budget)."""
    arr = np.frombuffer(jpeg, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ValueError("reencode: could not decode JPEG input")
    h, w = bgr.shape[:2]
    long_edge = max(h, w)
    if long_edge > max_edge:
        scale = max_edge / long_edge
        bgr = cv2.resize(bgr, (int(w * scale), int(h * scale)),
                         interpolation=cv2.INTER_AREA)
    ok, out = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ValueError("reencode: JPEG encode failed")
    return out.tobytes()


class _JpegPusher:
    """Non-blocking TCP pusher of concatenated JPEG frames to the panel.

    Frame-boundary safe: a frame is either fully queued to the kernel or
    dropped. A partially-sent frame is finished before any newer frame is
    considered; newer frames arriving while a partial send is pending are
    dropped. Reconnects with capped exponential backoff.
    """

    STALE_PARTIAL_S = 5.0

    def __init__(self, host: str, port: int):
        self.host = host
        self.port = port
        self._sock: socket.socket | None = None
        self._pending: bytes = b""
        self._pending_t = 0.0
        self._backoff = config.BACKOFF_INITIAL_S
        self._next_connect_t = 0.0
        self._drops = 0

    def _connect(self) -> None:
        now = time.time()
        if now < self._next_connect_t:
            return
        try:
            sock = socket.create_connection((self.host, self.port), timeout=2.0)
            sock.setblocking(False)
            self._sock = sock
            self._pending = b""
            self._backoff = config.BACKOFF_INITIAL_S
            log.info("jpeg push: connected to %s:%d", self.host, self.port)
        except OSError as exc:
            self._sock = None
            self._next_connect_t = now + self._backoff
            log.debug("jpeg push: connect failed (%s), retry in %.1fs",
                      exc, self._backoff)
            self._backoff = min(self._backoff * 2, config.BACKOFF_MAX_S)

    def _reset(self, why: str) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
        self._sock = None
        self._pending = b""
        self._next_connect_t = time.time() + self._backoff
        self._backoff = min(self._backoff * 2, config.BACKOFF_MAX_S)
        log.warning("jpeg push: reset (%s)", why)

    def _try_send(self, data: bytes) -> bytes:
        """Send as much as possible; return the unsent remainder."""
        assert self._sock is not None
        while data:
            try:
                n = self._sock.send(data)
            except (BlockingIOError, InterruptedError):
                return data
            except OSError as exc:
                self._reset(f"send error: {exc}")
                return b""
            if n <= 0:
                return data
            data = data[n:]
        return b""

    def push(self, jpeg: bytes) -> None:
        """Offer one frame. Never blocks the capture loop."""
        if self._sock is None:
            self._connect()
            if self._sock is None:
                return
        if self._pending:
            if time.time() - self._pending_t > self.STALE_PARTIAL_S:
                self._reset("stale partial frame")
                return
            self._pending = self._try_send(self._pending)
            if self._pending or self._sock is None:
                self._drops += 1
                return  # still draining the old frame: drop this one
        remainder = self._try_send(jpeg)
        if remainder and self._sock is not None:
            self._pending = remainder
            self._pending_t = time.time()

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None


class OverlayState:
    """Latest detection boxes, drawn onto the pushed (browser-facing) stream.

    Written by the async overlay-detection task, read by the camera thread.
    Stale boxes (detector stalled) stop being drawn after OVERLAY_TTL_S.
    """

    TTL_S = 2.0

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._boxes: list[dict] = []
        self._t = 0.0

    def set(self, boxes: list[dict]) -> None:
        with self._lock:
            self._boxes = boxes
            self._t = time.time()

    def draw(self, bgr: np.ndarray) -> np.ndarray:
        with self._lock:
            boxes, t = self._boxes, self._t
        if not boxes or time.time() - t > self.TTL_S:
            return bgr
        out = bgr.copy()
        for b in boxes:
            x1, y1, x2, y2 = b["xyxy"]
            color = (80, 80, 255) if b.get("cls") == "face" else (80, 220, 80)
            cv2.rectangle(out, (x1, y1), (x2, y2), color, 2)
            label = f"{b.get('cls', '?')} {b.get('conf', 0):.2f}"
            cv2.putText(out, label, (x1, max(14, y1 - 6)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)
        return out


class RobotCamera:
    """Owns /dev/video0 in a dedicated thread; fills a FrameSlot and pushes."""

    def __init__(self, slot: FrameSlot, overlay: "OverlayState | None" = None):
        self.slot = slot
        self.overlay = overlay
        self._pusher = _JpegPusher(config.JPEG_PUSH_HOST, config.JPEG_PUSH_PORT)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(
            target=self._run, name="robot-cam", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
        self._pusher.close()

    def _open(self) -> cv2.VideoCapture | None:
        cap = cv2.VideoCapture(config.ROBOT_CAM_INDEX, cv2.CAP_V4L2)
        if not cap.isOpened():
            cap.release()
            return None
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, config.ROBOT_CAM_WIDTH)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, config.ROBOT_CAM_HEIGHT)
        cap.set(cv2.CAP_PROP_FPS, config.ROBOT_CAM_FPS)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap

    def _run(self) -> None:
        params = [cv2.IMWRITE_JPEG_QUALITY, config.ROBOT_CAM_JPEG_QUALITY]
        while not self._stop.is_set():
            cap = self._open()
            if cap is None:
                log.error("robot cam: cannot open /dev/video%d, retrying",
                          config.ROBOT_CAM_INDEX)
                self._stop.wait(config.ROBOT_CAM_REOPEN_DELAY_S)
                continue
            log.info("robot cam: opened MJPG %dx%d@%d",
                     config.ROBOT_CAM_WIDTH, config.ROBOT_CAM_HEIGHT,
                     config.ROBOT_CAM_FPS)
            failures = 0
            while not self._stop.is_set():
                ok, bgr = cap.read()
                if not ok or bgr is None:
                    failures += 1
                    if failures >= 30:
                        log.error("robot cam: repeated read failures, reopening")
                        break
                    continue
                failures = 0
                ok, jpeg = cv2.imencode(".jpg", bgr, params)
                if not ok:
                    log.warning("robot cam: JPEG encode failed, frame skipped")
                    continue
                data = jpeg.tobytes()
                # The slot keeps the CLEAN frame (VLM sees unbiased pixels);
                # the browser-facing push gets the live detection overlay.
                self.slot.update(data, bgr)
                if self.overlay is not None:
                    drawn = self.overlay.draw(bgr)
                    if drawn is not bgr:
                        ok2, jpeg2 = cv2.imencode(".jpg", drawn, params)
                        if ok2:
                            data = jpeg2.tobytes()
                self._pusher.push(data)
            cap.release()
        log.info("robot cam: stopped")


class SideCamReader:
    """Async multipart MJPEG reader of the panel's /stream/pc endpoint.

    Boundary-agnostic: scans the byte stream for SOI..EOI pairs and keeps
    only the newest complete frame.
    """

    MAX_BUF = 4 * 1024 * 1024

    def __init__(self, slot: FrameSlot, session: aiohttp.ClientSession):
        self.slot = slot
        self._session = session

    async def run(self) -> None:
        backoff = config.BACKOFF_INITIAL_S
        while True:
            try:
                await self._read_stream()
                backoff = config.BACKOFF_INITIAL_S
            except asyncio.CancelledError:
                raise
            except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
                log.warning("side cam: stream error (%s), retry in %.1fs",
                            exc, backoff)
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, config.BACKOFF_MAX_S)

    async def _read_stream(self) -> None:
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=5,
                                        sock_read=15)
        async with self._session.get(config.SIDE_CAM_STREAM_URL,
                                     timeout=timeout) as resp:
            if resp.status != 200:
                raise aiohttp.ClientError(
                    f"/stream/pc returned HTTP {resp.status}")
            log.info("side cam: stream connected")
            buf = bytearray()
            async for chunk in resp.content.iter_chunked(65536):
                buf.extend(chunk)
                latest = None
                while True:
                    soi = buf.find(_SOI)
                    if soi < 0:
                        del buf[:]
                        break
                    eoi = buf.find(_EOI, soi + 2)
                    if eoi < 0:
                        if soi > 0:
                            del buf[:soi]
                        break
                    latest = bytes(buf[soi:eoi + 2])
                    del buf[:eoi + 2]
                if latest is not None:
                    self.slot.update(latest)
                if len(buf) > self.MAX_BUF:
                    log.warning("side cam: parse buffer overflow, resetting")
                    del buf[:]
