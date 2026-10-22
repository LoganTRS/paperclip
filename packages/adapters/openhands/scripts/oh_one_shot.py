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
    p.add_argument(
        "--stuck-retries",
        type=int,
        default=1,
        help="Bounded recovery turns after the SDK stuck detector fires (0 disables).",
    )
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

        # Toolset.
        #
        # The SDK `Agent` has NO default tools (the `tools` field defaults to
        # []), so a bare `Agent(llm=llm)` can only `think` and `finish` — it
        # cannot run bash, edit files, or otherwise act on the environment. The
        # earlier one-shot helper relied on that bare construction, which meant
        # the agent could narrate "I will mark the issue done" but had no tool
        # to actually do it.
        #
        # Use the SDK's canonical default preset (get_default_tools) rather than
        # hand-rolling a list: it is the toolset OpenHands itself ships as the
        # standard agent experience, and it stays correct as the SDK evolves.
        #
        # - enable_browser=False: this is a headless one-shot runner; the agent
        #   should drive GitHub/repo work via `gh`/API (per the system-prompt
        #   security policy) rather than a browser, and browser tools can hang
        #   on air-gapped networks. The SDK's own CLI disables browser in
        #   cli_mode for the same reason.
        # - Override with OPENHANDS_TOOLS (comma-separated tool names, e.g.
        #   "terminal,file_editor,task_tracker") when a run needs a narrower or
        #   wider toolset. Empty/absent => the canonical default (terminal,
        #   file_editor, task_tracker).
        from openhands.sdk import Tool

        tools_env = os.environ.get("OPENHANDS_TOOLS", "").strip()
        if tools_env:
            tool_specs = [Tool(name=n.strip()) for n in tools_env.split(",") if n.strip()]
        else:
            from openhands.tools.preset.default import get_default_tools
            tool_specs = get_default_tools(enable_browser=False)
        agent_kwargs = {}
        agent_kwargs["tools"] = tool_specs
        # AgentContext: the SDK's `Agent` takes an AgentContext (object), not a
        # raw string. A custom --system prompt is injected as the system-message
        # suffix.
        #
        # Skill router: always construct the context with load_user_skills=True
        # (even when no --system is given) so the SDK's native skill router is
        # active. It scans ~/.openhands/skills/ (and the legacy
        # ~/.openhands/microagents/) for user skills:
        #   - trigger=None (no `triggers:`/`inputs:` frontmatter) => repo skill,
        #     injected into the system prompt on every turn;
        #   - trigger set => knowledge skill, matched per-turn against the user
        #     message and injected when a keyword fires.
        # $HOME resolves to /paperclip for the adapter process, so user skills
        # live at /paperclip/.openhands/skills/ (persistent — it is inside the
        # bind-mounted data volume and survives image rebuilds).
        from openhands.sdk.context.agent_context import AgentContext
        agent_kwargs["agent_context"] = AgentContext(
            system_message_suffix=args.system,
            load_user_skills=True,
        )
        # Context condenser (default: none). Without one, the FULL event
        # history is re-sent on every LLM call, so input tokens grow
        # ~linearly for the whole run (verified: a 30-min coding run
        # reached ~11M cumulative input tokens and died on the adapter's
        # 30-min wall-clock timeout mid-work). A summarizing condenser
        # keeps head + recent tail and folds the middle into a rolling
        # summary, bounding the per-call input size and extending the
        # practical run length. max_size is in EVENTS (not tokens); 150
        # keeps the tail well within a ~128K-token window even with
        # verbose tool observations.
        # OPENHANDS_CONDENSER=max_size disables it (value <= 0) for
        # runs that need the full uncondensed history.
        condenser_env = os.environ.get("OPENHANDS_CONDENSER", "150").strip()
        try:
            condenser_max_size = int(condenser_env)
        except ValueError:
            condenser_max_size = 150
        if condenser_max_size > 0:
            from openhands.sdk.context.condenser import LLMSummarizingCondenser
            agent_kwargs["condenser"] = LLMSummarizingCondenser(
                llm=llm,
                max_size=condenser_max_size,
                keep_first=4,
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

        # If the SDK's StuckDetector fired, the run loop ends with
        # execution_status == STUCK and the agent was NOT given a chance to
        # step back, summarize what it was doing, or call the finish tool.
        # The run() loop only re-enters for IDLE/PAUSED — a second run() on a
        # STUCK conversation is a no-op — so the recovery uses a fresh
        # conversation seeded with the prior event history as context,
        # bounded to a single turn (--stuck-retries, default 1). The agent is
        # told explicitly to stop probing and emit a short summary + next
        # step. The recovery's final response REPLACES the stuck run's last
        # (repeated) message in the emitted output, so Paperclip's issue
        # comment carries a real handoff instead of the last loop iteration.
        recovery_final = None
        stuck_state_name = None
        try:
            # Imported here (runtime, container venv) because pyright in
            # this repo cannot resolve the SDK's import graph.
            from openhands.sdk.conversation.state import (
                ConversationExecutionStatus,
            )

            stuck_state_name = ConversationExecutionStatus.STUCK
            _stuck = conv.state.execution_status == stuck_state_name
        except Exception:
            _stuck = False
        if _stuck:
            log("[openhands] stuck state detected; running bounded recovery turn")
            recovery_prompt = (
                "STOP: you are being interrupted because the runtime detected "
                "you were repeating the same commands or edits without gaining "
                "new information. Do NOT re-run or re-edit anything in this "
                "turn. In your final message, state concisely: "
                "(1) what you have verified and what work is already "
                "committed or working, (2) exactly what you were repeating, "
                "(3) the single most likely next step to finish the task, "
                "(4) any environment or spec ambiguity you hit. Keep it "
                "under 300 words."
            )
            retries = max(0, min(getattr(args, "stuck_retries", 0), 2))
            for _ in range(retries):
                try:
                    recovery_conv = LocalConversation(
                        agent=agent,
                        workspace=workspace,
                        max_iteration_per_run=3,
                        stuck_detection=True,
                    )
                    recovery_conv.send_message(recovery_prompt)
                    recovery_conv.run()
                    rec_events = list(recovery_conv.state.events)
                    recovery_final = get_agent_final_response(rec_events)
                    if recovery_final:
                        log(
                            "[openhands] stuck recovery produced a final "
                            "response; using it instead of the stuck run's last message"
                        )
                    break
                except Exception as rec_err:  # noqa: BLE001
                    log(
                        f"[openhands] stuck-recovery turn failed: "
                        f"{type(rec_err).__name__}: {rec_err}"
                    )
                    break

        events = list(conv.state.events)
        final = get_agent_final_response(events)
        if recovery_final:
            final = recovery_final

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
