#!/usr/bin/env python3
"""A persona-swarm driver in plain Python (standard library only).

Proves that drivers are language-neutral: it speaks the driver protocol (JSON-RPC 2.0, one JSON object
per line on stdin/stdout) and talks to the persona's MCP tool server over HTTP. Its behaviour is
deliberately simple and deterministic: look at the screen, think aloud, finish. Use it as the
skeleton of a driver for any agent framework in Python.
"""
import json
import sys
import threading
import urllib.request

PROTOCOL_VERSION = 1
MCP_PROTOCOL = "2025-06-18"
cancelled = set()
lock = threading.Lock()


def send(message):
    with lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def log(text):
    sys.stderr.write(f"[python-reference] {text}\n")
    sys.stderr.flush()


class McpClient:
    """A minimal MCP client for the streamable HTTP transport with JSON responses."""

    def __init__(self, url, headers):
        self.url = url
        self.headers = dict(headers)
        self.session = None
        self.next_id = 1

    def _post(self, payload, expect_reply=True):
        headers = {
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "mcp-protocol-version": MCP_PROTOCOL,
            **self.headers,
        }
        if self.session:
            headers["mcp-session-id"] = self.session
        request = urllib.request.Request(self.url, data=json.dumps(payload).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=330) as response:
            self.session = response.headers.get("mcp-session-id", self.session)
            body = response.read().decode()
        if not expect_reply or not body:
            return None
        if body.startswith("event:") or body.startswith("data:"):
            body = next(line[5:].strip() for line in body.splitlines() if line.startswith("data:"))
        reply = json.loads(body)
        if "error" in reply:
            raise RuntimeError(reply["error"].get("message", "MCP error"))
        return reply.get("result")

    def request(self, method, params):
        self.next_id += 1
        return self._post({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})

    def connect(self):
        result = self.request(
            "initialize",
            {"protocolVersion": MCP_PROTOCOL, "capabilities": {}, "clientInfo": {"name": "persona-swarm-python", "version": "0.1.0"}},
        )
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"}, expect_reply=False)
        return result

    def tools(self):
        return [tool["name"] for tool in self.request("tools/list", {})["tools"]]

    def call(self, name, arguments):
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        text = "\n".join(part.get("text", "") for part in result.get("content", []) if part.get("type") == "text")
        return text, bool(result.get("isError"))


def run_session(spec):
    session_id = spec["sessionId"]
    client = McpClient(spec["mcp"]["url"], spec["mcp"].get("headers", {}))
    client.connect()
    names = client.tools()
    turns = 0

    def step(name, arguments):
        nonlocal turns
        turns += 1
        send({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": {"type": "turn", "n": turns}}})
        call_id = f"py-{turns}"
        send({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": {"type": "tool_call", "name": name, "input": arguments, "callId": call_id}}})
        text, is_error = client.call(name, arguments)
        send({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": {"type": "tool_result", "name": name, "callId": call_id, "ok": not is_error, "summary": text[:300]}}})
        return text

    view = step("outline", {}) if "outline" in names else step("screenshot", {})
    if session_id in cancelled:
        return {"stopReason": "cancelled", "finalMessage": "", "turns": turns}
    first_line = view.splitlines()[0] if view else "an empty screen"
    step("note", {"text": f"I am a Python driver. I see: {first_line[:200]}"})
    step(
        "finish",
        {"outcome": "completed", "summary": "Looked at the first screen.", "ease": 5, "trust": 5, "would_use": "maybe", "why": "Reference driver."},
    )
    return {"stopReason": "finished", "finalMessage": "python reference driver done", "turns": turns, "usage": {"inputTokens": 0, "outputTokens": 0}}


def handle(message):
    method = message.get("method")
    if "id" not in message:
        if method == "session.cancel":
            cancelled.add(message["params"]["sessionId"])
        return
    request_id = message["id"]
    params = message.get("params") or {}
    try:
        if method == "initialize":
            result = {"protocolVersion": PROTOCOL_VERSION, "driver": {"name": "python-reference", "version": "0.1.0"}}
        elif method == "capabilities":
            result = {"imageInput": True, "contextWindow": 1_000_000, "toolCalling": True, "usesModel": False, "notes": "deterministic reference behaviour"}
        elif method == "session.run":
            result = run_session(params)
        elif method == "shutdown":
            send({"jsonrpc": "2.0", "id": request_id, "result": {}})
            sys.exit(0)
        else:
            send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"unknown method {method}"}})
            return
        send({"jsonrpc": "2.0", "id": request_id, "result": result})
    except Exception as error:  # noqa: BLE001 - report every failure to the host
        log(f"{method} failed: {error}")
        if method == "session.run":
            send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "error", "finalMessage": "", "turns": 0, "error": str(error)}})
        else:
            send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32603, "message": str(error)}})


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "invalid JSON"}})
            continue
        # Sessions run on their own thread so cancel notices can arrive meanwhile.
        if message.get("method") == "session.run":
            threading.Thread(target=handle, args=(message,), daemon=True).start()
        else:
            handle(message)


if __name__ == "__main__":
    main()
