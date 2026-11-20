"""Minimal async Groq client (OpenAI-compatible chat completions).

Features: JSON mode, token streaming, automatic model fallback, retry on transient
errors, and rate-limit tracking (from Groq's x-ratelimit-* headers) so the engine can
avoid hitting the free-tier limits instead of failing.
"""
import asyncio
import json
import logging
import re
import time

import httpx

log = logging.getLogger("aether.llm")

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
FALLBACK_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]


class LLMError(Exception):
    pass


def _dur(s):
    """Parse Groq reset durations like '577ms', '14m24s', '1m26.4s', '2.5s' -> seconds."""
    if not s:
        return 0.0
    total = 0.0
    for num, unit in re.findall(r"([\d.]+)(ms|h|m|s)", s):
        v = float(num)
        total += {"ms": v / 1000, "s": v, "m": v * 60, "h": v * 3600}[unit]
    return total


class GroqClient:
    def __init__(self, api_key: str):
        self.api_key = api_key
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(30, connect=10))
        self.dead_models = set()
        self.limits = {}  # model -> {"tokens", "tokens_reset_at", "requests", "requests_reset_at"}

    # ---------- rate-limit tracking ----------
    def _track(self, model, headers):
        try:
            now = time.time()
            lim = self.limits.setdefault(model, {})
            if "x-ratelimit-remaining-tokens" in headers:
                lim["tokens"] = int(float(headers["x-ratelimit-remaining-tokens"]))
                lim["tokens_reset_at"] = now + _dur(headers.get("x-ratelimit-reset-tokens"))
            if "x-ratelimit-remaining-requests" in headers:
                lim["requests"] = int(float(headers["x-ratelimit-remaining-requests"]))
                lim["requests_reset_at"] = now + _dur(headers.get("x-ratelimit-reset-requests"))
        except (ValueError, TypeError):
            pass

    def tokens_left(self, model):
        lim = self.limits.get(model)
        if not lim or "tokens" not in lim or time.time() >= lim.get("tokens_reset_at", 0):
            return 10**9  # unknown or window has reset
        return lim["tokens"]

    def requests_left(self, model):
        lim = self.limits.get(model)
        if not lim or "requests" not in lim or time.time() >= lim.get("requests_reset_at", 0):
            return 10**9
        return lim["requests"]

    # ---------- helpers ----------
    def _candidates(self, preferred):
        out = []
        for m in [preferred, *FALLBACK_MODELS]:
            if m and m not in out and m not in self.dead_models:
                out.append(m)
        return out

    def _body(self, m, messages, max_tokens, temperature, json_mode, stream=False):
        body = {"model": m, "messages": messages, "temperature": temperature, "max_tokens": max_tokens}
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        if stream:
            body["stream"] = True
        if m.startswith("openai/gpt-oss"):
            body["reasoning_effort"] = "low"  # keep latency low; reasoning tokens count toward max_tokens
            body["max_tokens"] = max_tokens + 400
        return body

    def _classify(self, m, status, text):
        """Return 'retry', 'next' (try next model) or raise."""
        log.warning("groq %s -> HTTP %s: %s", m, status, text[:200])
        if status == 429:
            return "next"
        if status in (400, 404) and ("model_not_found" in text or "decommissioned" in text):
            self.dead_models.add(m)
            return "next"
        if status == 401:
            raise LLMError("Groq API key is invalid (HTTP 401).")
        if status >= 500:
            return "retry"
        return "next"

    @property
    def _headers(self):
        return {"Authorization": f"Bearer {self.api_key}"}

    # ---------- non-streaming ----------
    async def chat(self, messages, model, json_mode=True, max_tokens=900, temperature=0.3):
        last_err = None
        for m in self._candidates(model):
            body = self._body(m, messages, max_tokens, temperature, json_mode)
            for attempt in range(2):
                try:
                    r = await self.http.post(GROQ_URL, json=body, headers=self._headers)
                except httpx.HTTPError as e:
                    last_err = f"network: {e}"
                    await asyncio.sleep(0.7)
                    continue
                self._track(m, r.headers)
                if r.status_code == 200:
                    content = r.json()["choices"][0]["message"]["content"] or ""
                    try:
                        return parse_json(content) if json_mode else content
                    except LLMError as e:
                        last_err = f"{m}: {e}"
                        continue  # malformed output: retry once
                last_err = f"{m}: HTTP {r.status_code} {r.text[:200]}"
                action = self._classify(m, r.status_code, r.text)
                if action == "retry":
                    await asyncio.sleep(0.7)
                    continue
                break
        raise LLMError(last_err or "LLM call failed")

    # ---------- streaming ----------
    async def stream_text(self, messages, model, max_tokens=300, temperature=0.4):
        """Async generator yielding content deltas. Falls back to other models if the
        request fails before any text was produced."""
        last_err = None
        for m in self._candidates(model):
            body = self._body(m, messages, max_tokens, temperature, json_mode=False, stream=True)
            for attempt in range(2):
                yielded = False
                try:
                    async with self.http.stream("POST", GROQ_URL, json=body, headers=self._headers) as r:
                        self._track(m, r.headers)
                        if r.status_code != 200:
                            text = (await r.aread()).decode(errors="replace")
                            last_err = f"{m}: HTTP {r.status_code} {text[:200]}"
                            if self._classify(m, r.status_code, text) == "retry":
                                await asyncio.sleep(0.5)
                                continue
                            break
                        async for line in r.aiter_lines():
                            if not line.startswith("data:"):
                                continue
                            data = line[5:].strip()
                            if data == "[DONE]":
                                return
                            try:
                                delta = json.loads(data)["choices"][0]["delta"].get("content")
                            except (json.JSONDecodeError, KeyError, IndexError):
                                continue
                            if delta:
                                yielded = True
                                yield delta
                        return
                except httpx.HTTPError as e:
                    if yielded:
                        raise LLMError(f"stream interrupted: {e}")
                    last_err = f"network: {e}"
                    await asyncio.sleep(0.5)
                    continue
        raise LLMError(last_err or "LLM stream failed")


def parse_json(content: str):
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", content, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
    raise LLMError("Model did not return valid JSON")
