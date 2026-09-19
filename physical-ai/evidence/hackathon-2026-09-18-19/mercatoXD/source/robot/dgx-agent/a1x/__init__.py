"""A1X DGX agent: Qwen3-VL monitoring agent for the manipulator workspace.

Outbound-only service on the DGX Spark. Owns the arm-mounted camera,
talks to the laptop web panel (10.42.0.1) over WS/REST, runs local
detectors, and chats/patrols via a local vLLM endpoint.
"""

__version__ = "0.1.0"
