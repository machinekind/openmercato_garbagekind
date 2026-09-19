"""Static configuration for the A1X DGX agent (spec sections A, C, E, G)."""

import os
from pathlib import Path

# --- Network endpoints -------------------------------------------------------
# Hard invariant: the DGX initiates ALL connections outbound to the laptop.
LAPTOP_HOST = "10.42.0.1"
PANEL_BASE_URL = f"http://{LAPTOP_HOST}:8080"
PANEL_WS_URL = f"ws://{LAPTOP_HOST}:8080/ws"
SIDE_CAM_STREAM_URL = f"{PANEL_BASE_URL}/stream/pc"

# Raw concatenated-JPEG push of the robot cam to the panel's listener.
JPEG_PUSH_HOST = LAPTOP_HOST
JPEG_PUSH_PORT = 8097

# Local LLM endpoint. Day-1 stack is Ollama (weights already on the box);
# vLLM+FP8 (127.0.0.1:8000/v1, Qwen/Qwen3-VL-30B-A3B-Instruct-FP8) is the
# upgrade path. Ollama must be served with OLLAMA_CONTEXT_LENGTH>=32768 or it
# silently truncates multi-image history.
LLM_BASE_URL = os.environ.get("A1X_LLM_URL", "http://127.0.0.1:11434/v1")
LLM_MODEL = os.environ.get("A1X_LLM_MODEL", "qwen3-vl:30b-a3b-instruct")
LLM_API_KEY = "local"  # both servers ignore it; the openai client requires a value.
LLM_TIMEOUT_S = 300.0

# Identity used in /api/event "from" fields. Chat events whose "from" equals
# this value are the agent's own and MUST be ignored (no self-reply loop).
AGENT_NAME = "a1x"

# --- Robot camera (DGX /dev/video0, agent-owned per spec C) ------------------
ROBOT_CAM_INDEX = 0
ROBOT_CAM_WIDTH = 1280
ROBOT_CAM_HEIGHT = 720
ROBOT_CAM_FPS = 30
ROBOT_CAM_JPEG_QUALITY = 85
ROBOT_CAM_REOPEN_DELAY_S = 2.0

# --- Image budgets (spec E) --------------------------------------------------
IMAGE_MAX_LONG_EDGE = 1280       # frames re-encoded to <= this long edge
IMAGE_TOKENS_ESTIMATE = 900      # approx visual tokens per 1280px frame
MAX_IMAGES_IN_HISTORY = 4        # older image parts pruned, captions kept
MAX_IMAGES_PER_PROMPT = 8        # matches vllm --limit-mm-per-prompt image=8
HISTORY_TOKEN_CAP = 32_000       # approximate token cap for pruned history

MAX_TOOL_ROUNDS = 20             # max ReAct steps per goal episode

# Live detection overlay on the browser-facing robot stream.
OVERLAY_FPS = 6                  # detection passes per second (boxes cached)
OVERLAY_MODELS = ("people", "faces")   # faces degrades silently if absent

# Persistent "what is where" world map built by scan_environment.
WORLDMAP_PATH = Path.home() / "a1x-agent" / "worldmap.json"

# Rolling long-term memory: trimmed history is summarized into this note
# instead of being forgotten; survives restarts.
MEMORY_PATH = Path.home() / "a1x-agent" / "memory.json"
MEMORY_MAX_WORDS = 180

# --- Reconnect / backoff -----------------------------------------------------
BACKOFF_INITIAL_S = 1.0
BACKOFF_MAX_S = 30.0

# Events poll fallback (used only while the WS is down).
EVENTS_POLL_INTERVAL_S = 2.0

# --- Detector assets (spec B/E) ----------------------------------------------
AGENT_HOME = Path(os.path.expanduser("~/a1x-agent"))
ENGINES_DIR = AGENT_HOME / "engines"
WEIGHTS_DIR = AGENT_HOME / "weights"
ALERTS_DIR = AGENT_HOME / "alerts"
ALERTS_MAX_AGE_S = 7 * 24 * 3600  # 7-day ring buffer of annotated alert JPEGs

# --- Patrol (spec G) ---------------------------------------------------------
PATROL_ROUTE = ["home", "table_wide", "door", "shelf_cans"]
PATROL_INTERVAL_S = 300
PATROL_MIN_INTERVAL_S = 60
PATROL_GOAL_TIMEOUT_S = 10.0
PATROL_SETTLE_S = 0.7            # settle time after goal reached before frames
PATROL_CONFIRM_GAP_S = 0.6       # gap between the two confirmation frames
PATROL_VLM_EVERY_N_CYCLES = 6    # "anything notable?" VLM summary cadence
PATROL_ALERT_DEDUPE_S = 600      # identical alert key suppressed for 10 min
PATROL_RESUME_AFTER_DISENGAGE_S = 60.0
PATROL_PPE_CONF = 0.5
PATROL_HAZARD_CONF = 0.4
PATROL_CAN_DELTA_ALERT = 3       # can-count deviation that triggers an alert
# Local hours during which the workspace should be empty (start, end).
# Wraps midnight. Set to None to disable the empty-hours person trigger.
PATROL_EMPTY_HOURS = (22, 6)

# Presets on which the can / hazard detectors run during patrol.
PATROL_CANS_PRESETS = {"shelf_cans", "table_wide"}
PATROL_HAZARDS_PRESETS = {"home", "table_wide", "door", "shelf_cans"}
