"""MJPEG camera sources for the web panel.

Every source ends the same way: a byte stream that is split into JPEG frames
(SOI 0xFFD8 .. EOI 0xFFD9) and published to a latest-frame broadcaster, so a
slow HTTP client skips frames instead of stalling the capture.

Device spec:
  /dev/video0               local V4L2, ffmpeg native MJPG passthrough
  ssh://host/dev/video0     captured remotely with gst-launch, re-encoded
                            small, piped back over the ssh channel itself
                            (for links where only ssh gets through)
  sshtcp://host/dev/video0[?via=addr&size=WxH&fps=N&quality=Q&pass=1]
                            gst-launch started over ssh, video flowing over a
                            DIRECT TCP connection from the remote host to us
                            (the ethernet cable here) - control via ssh, data
                            via LAN
  listen://[bind_ip[:port]][?peer=CIDR]
                            we only listen; the remote side (the DGX agent,
                            which owns its camera) connects in and pushes
                            concatenated JPEGs. Use this whenever the agent
                            is running - two processes cannot open the same
                            /dev/video0.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import os

log = logging.getLogger("camera")

SOI = b"\xff\xd8"
EOI = b"\xff\xd9"
MAX_BUFFER = 4 * 1024 * 1024  # a stuck parser must not eat RAM forever
RESTART_DELAY_S = 2.0
DEFAULT_LISTEN_HOST = "10.42.0.1"     # laptop end of the direct cable
DEFAULT_LISTEN_PORT = 8097
DEFAULT_PEER_NET = "10.42.0.0/24"


def _local_ip() -> str:
    """This machine's LAN IP (default-route source address)."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))     # no packet sent; just picks the route
        return s.getsockname()[0]
    finally:
        s.close()


class Camera:
    """Owns the capture process/socket and the latest decoded JPEG frame."""

    def __init__(self, device: str = "/dev/video0", size: str = "1280x720",
                 fps: int = 30, remote_size: str = "1280x720",
                 remote_fps: int = 20, remote_quality: int = 60,
                 tcp_port: int = DEFAULT_LISTEN_PORT):
        self.device = device
        self.size = size
        self.fps = fps
        self.remote_size = remote_size
        self.remote_fps = remote_fps
        self.remote_quality = remote_quality
        self.tcp_port = tcp_port
        self.ssh_host = ""
        self.remote_dev = ""
        self.push_mode = False
        self.listen_mode = False
        self.listen_host = DEFAULT_LISTEN_HOST
        self.peer_net = ipaddress.ip_network(DEFAULT_PEER_NET)
        self.via = ""          # address of THIS machine as the remote sees it
        self.passthrough = False
        self._parse(device)
        self.frame: bytes | None = None
        self.frame_event = asyncio.Event()
        self.frames_read = 0
        self.last_error = ""
        self._task: asyncio.Task | None = None

    # ---- spec parsing ----

    def _parse(self, device: str) -> None:
        if device.startswith("listen://"):
            self._parse_listen(device[len("listen://"):])
            return
        for scheme in ("sshtcp://", "ssh://"):
            if not device.startswith(scheme):
                continue
            rest = device[len(scheme):]
            rest, _, query = rest.partition("?")
            host, _, path = rest.partition("/")
            self.ssh_host = host
            self.remote_dev = "/" + path
            self.push_mode = scheme == "sshtcp://"
            if not self.push_mode:
                # ssh channel is narrow - shrink hard
                self.remote_size = "640x360"
                self.remote_fps = 6
                self.remote_quality = 45
            self._parse_query(query)
            return

    def _parse_listen(self, rest: str) -> None:
        self.listen_mode = True
        addr, _, query = rest.partition("?")
        addr = addr.strip("/")
        if addr:
            host, _, port = addr.partition(":")
            if host:
                self.listen_host = host
            if port:
                self.tcp_port = int(port)
        self._parse_query(query)

    def _parse_query(self, query: str) -> None:
        for kv in query.split("&"):
            k, _, v = kv.partition("=")
            if k == "via":
                self.via = v
            elif k == "size":
                self.remote_size = v
            elif k == "fps":
                self.remote_fps = int(v)
            elif k == "quality":
                self.remote_quality = int(v)
            elif k == "pass":
                self.passthrough = v not in ("0", "no")
            elif k == "port":
                self.tcp_port = int(v)
            elif k == "peer":
                self.peer_net = ipaddress.ip_network(v)

    # ---- lifecycle ----

    def start(self) -> None:
        self._task = asyncio.get_running_loop().create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _run(self) -> None:
        """Capture loop; restarts the source if it drops out."""
        was_missing = False
        while True:
            local = not self.ssh_host and not self.listen_mode
            if local and not os.path.exists(self.device):
                # absent device is a normal state (camera not plugged in yet);
                # note it once, keep polling quietly
                self.last_error = f"{self.device} not present (unplugged?)"
                if not was_missing:
                    log.info("%s not present, waiting for it", self.device)
                    was_missing = True
                await asyncio.sleep(RESTART_DELAY_S)
                continue
            was_missing = False
            try:
                await self._capture_once()
            except asyncio.CancelledError:
                raise
            except Exception as ex:                         # noqa: BLE001
                self.last_error = str(ex)
                log.warning("camera %s capture failed: %s", self.device, ex)
            await asyncio.sleep(RESTART_DELAY_S)

    # ---- sources ----

    def _pipeline(self, sink: str) -> str:
        """gst pipeline run on the remote host. Passthrough hands the camera's
        native MJPG straight to `sink` (needs a fat link, e.g. the ethernet
        cable at ~116 MB/s); otherwise decode, pace, scale, re-encode."""
        w, h = self.remote_size.split("x")
        if self.passthrough:
            return (f"v4l2src device={self.remote_dev} ! "
                    f"image/jpeg,width={w},height={h},"
                    f"framerate={self.remote_fps}/1 ! {sink}")
        return (f"v4l2src device={self.remote_dev} ! "
                f"image/jpeg,width={self.size.split('x')[0]},"
                f"height={self.size.split('x')[1]},framerate={self.fps}/1 ! "
                f"jpegdec ! videorate ! "
                f"video/x-raw,framerate={self.remote_fps}/1 ! "
                f"videoscale ! video/x-raw,width={w},height={h} ! "
                f"jpegenc quality={self.remote_quality} ! {sink}")

    def _ssh(self, remote_cmd: str) -> list[str]:
        return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
                "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3",
                self.ssh_host, remote_cmd]

    def _command(self) -> list[str]:
        if not self.ssh_host:
            return ["ffmpeg", "-hide_banner", "-loglevel", "error",
                    "-f", "v4l2", "-input_format", "mjpeg",
                    "-video_size", self.size, "-framerate", str(self.fps),
                    "-i", self.device,
                    "-c:v", "copy", "-f", "mjpeg", "-"]
        # ssh:// - video comes back through the ssh channel itself
        return self._ssh(
            f"exec gst-launch-1.0 -q {self._pipeline('fdsink fd=1')}")

    async def _serve_push(self, bind_host: str | None) -> asyncio.Server:
        """TCP listener that accepts ONE pusher from the allowed peer net."""
        self._conn: dict = {}
        self._got_conn = asyncio.Event()

        async def on_client(reader, writer):
            peer = writer.get_extra_info("peername")
            host = peer[0] if peer else ""
            try:
                allowed = ipaddress.ip_address(host) in self.peer_net
            except ValueError:
                allowed = False
            if not allowed:
                log.warning("rejected frame push from %s (outside %s)",
                            host, self.peer_net)
                writer.close()
                return
            if self._conn:
                writer.close()            # one pusher at a time
                return
            self._conn = {"reader": reader, "writer": writer}
            log.info("frame push accepted from %s", host)
            self._got_conn.set()

        return await asyncio.start_server(on_client, bind_host, self.tcp_port)

    async def _read_push(self, timeout: float) -> None:
        """Drain the accepted push connection until it closes."""
        reader = self._conn["reader"]
        buf = b""
        while True:
            chunk = await asyncio.wait_for(reader.read(65536), timeout=timeout)
            if not chunk:
                break
            buf += chunk
            buf = self._extract_frames(buf)
            if len(buf) > MAX_BUFFER:
                buf = b""
        raise RuntimeError("push connection closed")

    async def _capture_listen(self) -> None:
        """listen://: the remote owns its camera and pushes frames to us."""
        server = await self._serve_push(self.listen_host)
        log.info("listening for pushed MJPEG on %s:%d (peers %s)",
                 self.listen_host, self.tcp_port, self.peer_net)
        try:
            await self._got_conn.wait()
            await self._read_push(timeout=30.0)
        finally:
            self._close_conn()
            server.close()
            await server.wait_closed()

    async def _capture_push(self) -> None:
        """sshtcp://: we listen, the remote gst pushes MJPEG to us over a
        direct TCP connection; ssh only starts the pipeline."""
        data_host = self.via or _local_ip()
        server = await self._serve_push(None)
        # gst's tcpclientsink cannot parse a scoped IPv6 address
        # (fe80::...%iface), so the pipeline writes to stdout and a small
        # python sender on the remote host does the TCP connection.
        sender = ("import socket,sys;"
                  f"ai=socket.getaddrinfo({data_host!r},{self.tcp_port},"
                  "type=socket.SOCK_STREAM);"
                  "s=socket.socket(ai[0][0]);s.connect(ai[0][4]);"
                  "w=sys.stdin.buffer;"
                  "[s.sendall(b) for b in iter(lambda:w.read(65536),b'')]")
        remote = (f"gst-launch-1.0 -q {self._pipeline('fdsink fd=1')}"
                  f" | exec python3 -c \"{sender}\"")
        proc = await asyncio.create_subprocess_exec(
            *self._ssh(remote),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE)
        log.info("push capture: remote %s -> tcp %s:%d (%s @ %d fps%s)",
                 self.remote_dev, data_host, self.tcp_port,
                 self.remote_size, self.remote_fps,
                 " passthrough" if self.passthrough
                 else f" q{self.remote_quality}")
        try:
            try:
                await asyncio.wait_for(self._got_conn.wait(), timeout=15.0)
            except asyncio.TimeoutError:
                err = b""
                if proc.returncode is not None:
                    err = await proc.stderr.read()
                raise RuntimeError(
                    "remote never connected back over TCP: "
                    + (err.decode(errors='replace').strip() or "timeout"))
            await self._read_push(timeout=10.0)
        finally:
            self._close_conn()
            server.close()
            await server.wait_closed()
            if proc.returncode is None:
                proc.kill()
                await proc.wait()

    def _close_conn(self) -> None:
        writer = self._conn.get("writer") if hasattr(self, "_conn") else None
        if writer is not None:
            writer.close()
        self._conn = {}

    async def _capture_once(self) -> None:
        if self.listen_mode:
            await self._capture_listen()
            return
        if self.push_mode:
            await self._capture_push()
            return
        cmd = self._command()
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        log.info("capture started on %s (%s)", self.device,
                 f"remote {self.remote_size} @ {self.remote_fps} fps"
                 if self.ssh_host else f"{self.size} @ {self.fps} fps")
        buf = b""
        try:
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                buf += chunk
                buf = self._extract_frames(buf)
                if len(buf) > MAX_BUFFER:
                    buf = b""
            err = (await proc.stderr.read()).decode(errors="replace").strip()
            raise RuntimeError(f"capture exited: {err or 'no stderr'}")
        finally:
            if proc.returncode is None:
                proc.kill()
                await proc.wait()

    # ---- frame plumbing ----

    def _extract_frames(self, buf: bytes) -> bytes:
        """Publish every complete JPEG in buf; return the unconsumed tail."""
        while True:
            start = buf.find(SOI)
            if start < 0:
                return b""
            end = buf.find(EOI, start + 2)
            if end < 0:
                return buf[start:]
            self.frame = buf[start:end + 2]
            self.frames_read += 1
            self.frame_event.set()
            self.frame_event = asyncio.Event()
            buf = buf[end + 2:]

    async def next_frame(self) -> bytes | None:
        """Wait for the next frame; returns the latest one."""
        event = self.frame_event
        try:
            await asyncio.wait_for(event.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            return None
        return self.frame
