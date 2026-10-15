#!/usr/bin/env python3
"""
OpenHands one-shot SDK runner (Paperclip adapter helper).

Invoked by the `openhands_local` adapter as:
    <python> oh_one_shot.py --prompt-file <path> --workdir <dir> \
        [--conversation-id <uuid>] [--max-iterations N] [--system <text>]

It performs a single non-interactive OpenHands agent turn against an
OpenAI-compatible endpoint (the LiteLLM proxy) and prints a single JSON
object to stdout describing the result. All logging goes to stderr so stdout
stays a clean machine-readable channel.

Result JSON contract (stdout, single line):
    {
      "ok": bool,
      "response": str,            # final agent answer
      "conversation_id": str,     # session id to resume
      "usage": {"input_tokens": int, "output_tokens": int} | null,
      "error": str | null,
      "timed_out": bool            # set true when killed externally is not possible;
                                    # adapter derives timeout from process exit
    }

Credentials come from the environment (never from CLI args):
    OPENHANDS_LITELLM_PROXY_BASE   base URL (OpenAI-compatible)
    OPENHANDS_LITELLM_PROXY_KEY    API key
    OPENHANDS_LITELLM_PROXY_MODEL  model name
"""

import argparse
import json
import os
import sys
import uuid
import traceback


def log(*parts):
    print(*parts, file=sys.stderr)


def parse_args():
    p = argparse.ArgumentParser(description="OpenHands one-shot SDK runner")
    p.add_argument("--prompt-file", required=True, help="Path to a file containing the prompt.")
    p.add_argument("--workdir", required=True, help="Working directory for the conversation.")
    p.add_argument("--conversation-id", default=None, help="Resume this conversation id (uuid).")
    p.add_argument("--max-iterations", type=int, default=500, help="Max iterations per run.")
    p.add_argument("--system", default=None, help="Optional system prompt override.")
    return p.parse_args()


def emit(payload):
    # Single-line JSON to stdout — the adapter reads this.
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def main():
    args = parse_args()

    # Load credentials from the environment.
    base_url = os.environ.get("OPENHANDS_LITELLM_PROXY_BASE", "").strip()
    api_key = os.environ.get("OPENHANDS_LITELLM_PROXY_KEY", "").strip()
    model = os.environ.get("OPENHANDS_LITELLM_PROXY_MODEL", "").strip()

    if not base_url or not api_key or not model:
        emit({
            "ok": False,
            "response": "",
            "conversation_id": None,
            "usage": None,
            "error": "Missing OpenHands LLM credentials. Set OPENHANDS_LITELLM_PROXY_BASE, OPENHANDS_LITELLM_PROXY_KEY and OPENHANDS_LITELLM_PROXY_MODEL.",
            "timed_out": False,
        })
        return 0

    try:
        with open(args.prompt_file, "r", encoding="utf-8") as f:
            prompt = f.read()
    except Exception as e:  # noqa: BLE001
        emit({"ok": False, "response": "", "conversation_id": None, "usage": None,
              "error": f"Failed to read prompt file: {e}", "timed_out": False})
        return 0

    # Resolve conversation id for resume (generate if not resuming).
    conversation_id = args.conversation_id or None
    if conversation_id:
        try:
            conversation_id = str(uuid.UUID(conversation_id))
        except Exception:
            log(f"[openhands] WARNING: conversation-id {conversation_id!r} is not a valid UUID; starting fresh.")
            conversation_id = None
    if conversation_id is None:
        conversation_id = str(uuid.uuid4())

    # Workdir must exist.
    os.makedirs(args.workdir, exist_ok=True)

    # Defer imports so that credential/validation errors above surface before
    # the heavy SDK load.
    from openhands.sdk.llm import LLM
    from openhands.sdk.agent import Agent
    from openhands.sdk.conversation import LocalConversation
    from openhands.sdk.conversation.response_utils import get_agent_final_response
    from openhands.sdk.workspace import LocalWorkspace

    log(f"[openhands] starting one-shot turn model={model} base={base_url} conv={conversation_id} workdir={args.workdir}")

    try:
        # LiteLLM infers the provider from the model name. Custom gateway models
        # (e.g. trs-balanced) carry no recognizable prefix, so LiteLLM raises
        # "LLM Provider NOT provided". Prefixing with `openai/` tells LiteLLM to
        # route to the OpenAI-compatible endpoint at base_url.
        if "/" not in model and not model.startswith(("openai", "openrouter", "anthropic")):
            model = f"openai/{model}"
        llm = LLM(model=model, api_key=api_key, base_url=base_url)
        agent_kwargs = {}
        if args.system:
            # The SDK's `Agent` takes an AgentContext (object), not a raw string.
            # A custom --system prompt is injected as the system-message suffix.
            from openhands.sdk.context.agent_context import AgentContext
            agent_kwargs["agent_context"] = AgentContext(
                system_message_suffix=args.system
            )
        agent = Agent(llm=llm, **agent_kwargs)
        workspace = LocalWorkspace(working_dir=args.workdir)

        conv = LocalConversation(
            agent=agent,
            workspace=workspace,
            conversation_id=conversation_id,
            max_iteration_per_run=args.max_iterations,
        )

        conv.send_message(prompt)
        conv.run()

        events = list(conv.state.events)
        final = get_agent_final_response(events)

        # Best-effort usage aggregation from events.
        usage = {"input_tokens": 0, "output_tokens": 0}
        for ev in events:
            try:
                u = getattr(ev, "usage", None)
                if not u:
                    continue
                it = getattr(u, "input_tokens", 0) or 0
                ot = getattr(u, "output_tokens", 0) or 0
                usage["input_tokens"] += int(it or 0)
                usage["output_tokens"] += int(ot or 0)
            except Exception:
                pass

        conv.close()

        emit({
            "ok": True,
            "response": final or "",
            "conversation_id": conversation_id,
            "usage": usage,
            "error": None,
            "timed_out": False,
        })
        return 0
    except Exception as e:  # noqa: BLE001
        log("[openhands] ERROR:\n" + traceback.format_exc())
        emit({
            "ok": False,
            "response": "",
            "conversation_id": conversation_id,
            "usage": None,
            "error": f"{type(e).__name__}: {e}",
            "timed_out": False,
        })
        return 0


if __name__ == "__main__":
    sys.exit(main())
