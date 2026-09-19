"""OpenAI-compatible client wrapper for the local vLLM endpoint (spec A/E).

Locked-in behaviors:
- stream=False ALWAYS on any turn where tools are passed (hermes streaming
  parse bug, vllm#31871). This wrapper never streams at all.
- Images travel as data:image/jpeg;base64 parts inside USER-role messages,
  never tool-role (tool messages don't reliably carry images through
  OpenAI-compatible APIs).
- History pruning: image parts beyond the last MAX_IMAGES_IN_HISTORY frames
  are dropped (their text captions are kept); history is hard-capped at
  ~HISTORY_TOKEN_CAP estimated tokens, dropping oldest messages in
  tool-call-consistent blocks.
"""

import base64
import copy
import json
import logging
from typing import Any

from openai import AsyncOpenAI

from . import config

log = logging.getLogger(__name__)


def image_user_message(caption: str, jpeg: bytes) -> dict[str, Any]:
    """Build the user-role frame-injection message (spec E pattern)."""
    b64 = base64.b64encode(jpeg).decode("ascii")
    return {
        "role": "user",
        "content": [
            {"type": "text", "text": caption},
            {"type": "image_url",
             "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
        ],
    }


def _estimate_tokens(message: dict[str, Any]) -> int:
    """Rough token estimate: chars/4 for text, flat cost per image."""
    total = 8  # per-message overhead
    content = message.get("content")
    if isinstance(content, str):
        total += len(content) // 4
    elif isinstance(content, list):
        for part in content:
            if part.get("type") == "image_url":
                total += config.IMAGE_TOKENS_ESTIMATE
            else:
                total += len(part.get("text", "")) // 4
    for call in message.get("tool_calls") or []:
        try:
            total += len(json.dumps(call)) // 4
        except (TypeError, ValueError):
            total += 64
    return total


def prune_history(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return a pruned deep-ish copy of messages, per spec E.

    1. Keep image parts only in the last MAX_IMAGES_IN_HISTORY frames
       (bounded by MAX_IMAGES_PER_PROMPT); older frames keep captions only.
    2. Drop oldest non-system messages until under HISTORY_TOKEN_CAP,
       keeping assistant-tool_calls + their tool replies together.
    """
    pruned = [copy.copy(m) for m in messages]

    # Pass 1: image budget, newest-first.
    budget = min(config.MAX_IMAGES_IN_HISTORY, config.MAX_IMAGES_PER_PROMPT)
    kept = 0
    for i in range(len(pruned) - 1, -1, -1):
        content = pruned[i].get("content")
        if not isinstance(content, list):
            continue
        n_images = sum(1 for p in content if p.get("type") == "image_url")
        if n_images == 0:
            continue
        if kept + n_images <= budget:
            kept += n_images
            continue
        new_content = [p for p in content if p.get("type") != "image_url"]
        keep_here = max(0, budget - kept)
        if keep_here:
            tail_images = [p for p in content
                           if p.get("type") == "image_url"][-keep_here:]
            new_content.extend(tail_images)
            kept = budget
        msg = copy.copy(pruned[i])
        msg["content"] = new_content if new_content else "[frame pruned]"
        pruned[i] = msg

    # Pass 2: token cap, dropping oldest blocks after the system message.
    def total_tokens() -> int:
        return sum(_estimate_tokens(m) for m in pruned)

    start = 1 if pruned and pruned[0].get("role") == "system" else 0
    while total_tokens() > config.HISTORY_TOKEN_CAP and len(pruned) > start + 1:
        drop_end = start + 1
        if pruned[start].get("tool_calls"):
            # Drop the assistant tool-call turn together with its tool
            # replies and any injected frame messages that follow them.
            while (drop_end < len(pruned)
                   and pruned[drop_end].get("role") == "tool"):
                drop_end += 1
                while (drop_end < len(pruned)
                       and pruned[drop_end].get("role") == "user"
                       and isinstance(pruned[drop_end].get("content"), list)):
                    drop_end += 1
        del pruned[start:drop_end]
        # An orphaned tool reply at the new front would be rejected upstream.
        while (len(pruned) > start
               and pruned[start].get("role") == "tool"):
            del pruned[start]
    return pruned


class LLMClient:
    def __init__(self):
        self._client = AsyncOpenAI(
            base_url=config.LLM_BASE_URL,
            api_key=config.LLM_API_KEY,
            timeout=config.LLM_TIMEOUT_S,
            max_retries=1,
        )
        self.model = config.LLM_MODEL

    async def chat(self, messages: list[dict[str, Any]],
                   tools: list[dict[str, Any]] | None = None,
                   max_tokens: int = 1024):
        """One non-streaming chat completion. Returns the response message.

        stream=False unconditionally — mandatory whenever tools are passed
        (hermes streaming bug), and harmless otherwise.
        """
        pruned = prune_history(messages)
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": pruned,
            "max_tokens": max_tokens,
            "stream": False,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"
        response = await self._client.chat.completions.create(**kwargs)
        if not response.choices:
            raise RuntimeError("LLM returned no choices")
        return response.choices[0].message

    @staticmethod
    def assistant_message_dict(message) -> dict[str, Any]:
        """Convert an SDK response message into a history dict."""
        out: dict[str, Any] = {"role": "assistant",
                               "content": message.content or ""}
        if message.tool_calls:
            out["tool_calls"] = [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {
                        "name": call.function.name,
                        "arguments": call.function.arguments,
                    },
                }
                for call in message.tool_calls
            ]
        return out
