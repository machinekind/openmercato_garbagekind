# A1X web panel

Browser panel: the robot camera large in the middle, a chat column to the
DGX agent on the right, live joint state and the arm controls underneath.

```bash
python3 webpanel/server.py                      # robot cam pushed by the agent
python3 webpanel/server.py \
    --cameras "robot:sshtcp://machinekind-dgx/dev/video0?via=10.42.0.1&size=1280x720&fps=30&pass=1"
```

Then open <http://localhost:8080>.

The panel is the **only** transmitter on the CAN bus. Do not run
`so101_bridge.py`, the teleop scripts or the ROS driver with TX enabled at the
same time — two writers on `0x050` interleave and the arm sees garbage.
`can_up.sh` must have brought `can0` up first (it runs inside the
`galaxeo-ros2` container).

## Camera

The DGX agent owns the DGX `/dev/video0`, so only one of the two may capture
it:

| agent running? | `--cameras` |
|---|---|
| yes | `robot:listen://` — we listen on `10.42.0.1:8097`, the agent connects in and pushes JPEGs |
| no  | `robot:sshtcp://machinekind-dgx/dev/video0?via=10.42.0.1&pass=1` — we start the remote capture over ssh, video flows over the cable |

`listen://` accepts a connection only from the agent network
(`?peer=CIDR`, default `10.42.0.0/24`), one pusher at a time. Add the laptop
camera as a second view with `,pc:/dev/video0` if you want it — the agent
reads it as its side camera from `/stream/pc`.

## Roles

Role comes from the peer address: anything inside `--agent-net`
(`10.42.0.0/24`, the direct cable) is the **agent**, everything else is the
**operator**.

| | operator | agent |
|---|---|---|
| `chat` | yes | yes |
| `preset`, `pantilt`, `move_joints` | yes | only while engaged **and** "agent may move the arm" is ticked |
| `engage`, `disengage`, `stop`, `enable`, `goal`, `jog`, `grip` | yes | refused |

REST carries no motion at all, and a REST event may not claim to come from
`operator`.

## Safety

* Starts disengaged; nothing is transmitted until the operator presses
  Engage, and engaging latches the target to the measured pose.
* Every target passes through `presets.json`: the per-joint window is
  intersected with the URDF limits (a config typo can only narrow it),
  relative moves are capped per command, non-finite values are rejected.
* Slew-limited to `--slew` deg/s (30 by default).
* Stale CAN feedback, a lost link, or the last operator tab closing all
  auto-disengage. Ceasing TX is the safe failure mode: an uncommanded arm
  holds position.
* `FF 1→5→6` runs only on the explicit Enable button, streaming `p_des = q`
  throughout.

**The preset poses in `presets.json` are starting guesses** — drive to each
one with the arm clear of obstacles and correct the numbers before trusting
patrol or the agent's `goto_preset`.

## API (what the DGX agent uses)

| route | purpose |
|---|---|
| `GET /ws` | arm state @15 Hz, event broadcasts, command results; commands up |
| `GET /api/state` | the same snapshot over REST |
| `GET /api/events?since=SEQ` | event ring buffer (poll fallback while the WS is down) |
| `POST /api/event` | `{from, kind: chat\|status\|alert\|log, text, image?}` → `{ok, seq}` |
| `GET /api/presets` | `{presets: {name: {desc, q_deg}}}` |
| `GET/POST /api/map` | the agent's world map |
| `GET /stream/{name}` | multipart MJPEG |
| `GET /health` | camera + arm diagnostics, and your role |

State fields the agent reads: `q` (7 values, rad), `engaged`, `engaged_via`
(`operator` / `agent` / `none`), `goal_reached`, `moving`.

Run the agent with:

```bash
ssh machinekind-dgx 'cd ~/a1x-agent && setsid nohup venv/bin/python -m a1x.main \
    > agent.log 2>&1 < /dev/null &'
```
