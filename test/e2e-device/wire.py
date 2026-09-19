#!/usr/bin/env python3
"""Reading an HTTP response the way the door gate's ESP32 reads one.

`scenario.py` talks to the API through `urllib`, which frames, de-chunks and closes
for you. That is the one thing neither it nor any firmware fixture could see, and
round G3 found what it hid: the real API answers **every** device route
`Transfer-Encoding: chunked` on a keep-alive connection, and a reader that was
correct against every invented fixture timed out on **every** call against the
actual server — no roster, and a door that refused everyone.

So this module is a deliberately small, deliberately stupid HTTP client over a raw
socket, and it makes the same three decisions the firmware makes:

* **Framing is an INPUT, never a guess** — `Content-Length` wins, else a chunked
  `Transfer-Encoding`, else the body ends when the peer hangs up. This is
  `gatelogic::frameFromHeaders` in `src/iot/door-gate/lib/gatelogic`, and the
  precedence (a length beats a chunked header) is the same way round on purpose.
* **Three phases, three budgets** — connect, headers, body — and the **body's
  deadline is sampled AFTER the headers return**, not from the instant the call
  started. Round G2 did the latter, so a header phase that spent its budget left
  the body a deadline already in the past and a perfectly good roster was reported
  as a transport failure before a byte of it was read.
* **Anything but a whole body is status 0** — `gatelogic::statusForBody`. Not the
  status the peer sent: a 200 whose body did not fit, did not arrive or did not
  parse as chunks is not a 200 anybody can act on, and at a door the difference
  between "the server said no" and "the board learned nothing" is the difference
  between a refusal and a roster fallback.

The de-chunker is a byte-at-a-time state machine for the same reason the firmware's
is: a chunk, a chunk's size line and the final `0\\r\\n\\r\\n` all arrive split
across reads on a real board — a full 48-entry heartbeat is one 1489-byte chunk and
the MTU is 1460 — so a decoder that assumed a whole line was available would be
correct on the bench and wrong at the door.

**It is NOT a general HTTP client and must not become one.** No redirects, no
compression, no cookies, no connection pool beyond the one keep-alive socket the
1.1 pass needs to reproduce G3's hazard. Every line of generosity added here is a
line of framing the board does not have.

Stdlib only, like the scenario beside it.
"""

from __future__ import annotations

import json
import socket
import time
from dataclasses import dataclass, field
from typing import Optional

# ---------------------------------------------------------------------------
# The board's own numbers, mirrored from the firmware
# ---------------------------------------------------------------------------
#
# These are copies, and copies drift — which is why the script that imports this
# module asserts the live server against them rather than merely using them. The
# originals are `src/iot/door-gate/lib/gatelogic/include/gatelogic/GateConfig.h`
# (`kGateResponseCap`, the three timeouts) and `docs/specs/door-gate.md` §4
# (`MaxResponseBytes`). If a number here stops matching one there, the firmware
# project's header is right and this file is wrong.

#: `gatelogic::kGateResponseCap` — the board's static response buffer.
RESPONSE_CAP = 4608

#: `door-gate.md` §4 `MaxResponseBytes` — the ceiling the server promises to stay under.
MAX_RESPONSE_BYTES = 4096

#: `kHttpConnectTimeoutMs`, `kHttpResponseTimeoutMs`, `kHttpBodyBudgetMs`, in seconds.
CONNECT_BUDGET = 4.0
HEADER_BUDGET = 4.0
BODY_BUDGET = 4.0

#: Longest chunk-size line the firmware will accept: eight hex digits is a uint32.
MAX_CHUNK_SIZE_DIGITS = 8


class Framing:
    """The three shapes HTTP/1.1 has, named as `gatelogic::BodyFraming` names them."""

    KNOWN_LENGTH = "length"
    CHUNKED = "chunked"
    UNTIL_CLOSE = "close"


class BodyResult:
    """`gatelogic::BodyResult`, with the same four values and the same meanings."""

    OK = "ok"
    TOO_LARGE = "too_large"
    TIMEOUT = "timeout"
    MALFORMED = "malformed"


@dataclass
class BoardResponse:
    """One response as the board sees it.

    `status` is **already** through `statusForBody`: it is the peer's status when
    the whole body arrived, and `0` when it did not, whatever the peer said. Read
    `http_status` for what was actually on the status line — the two differing is
    precisely the class of defect this module exists to surface, so both are kept.
    """

    status: int
    http_status: int
    reason_phrase: str
    version: str
    headers: dict
    body: bytes
    framing: str
    body_result: str
    json: object = None
    text: str = ""
    elapsed_ms: int = 0
    #: Bytes of framing overhead: what the de-chunker consumed and did not hand up.
    wire_bytes: int = 0

    def get(self, key: str, default: object = None) -> object:
        return self.json.get(key, default) if isinstance(self.json, dict) else default

    def header(self, name: str) -> Optional[str]:
        return self.headers.get(name.lower())

    @property
    def chunked(self) -> bool:
        return self.framing == Framing.CHUNKED

    def summary(self) -> str:
        return (f"HTTP {self.http_status} via {self.version}, framing={self.framing}, "
                f"body={self.body_result} {len(self.body)}B, status_to_caller={self.status}")


class WireError(Exception):
    """The socket itself failed — refused, reset, DNS. Not a framing verdict."""


# ---------------------------------------------------------------------------
# The stream: available / read / connected, which is all WiFiClient offers
# ---------------------------------------------------------------------------


class _Stream:
    """A socket, presented as the four operations `IResponseStream` has.

    Deliberately no `readline`, no `makefile` and no "read exactly n": those are
    what a comfortable client has and a board does not, and a reader written
    against them cannot express "the peer stopped between two bytes of a chunk
    size line", which is the case that matters.
    """

    def __init__(self, sock: socket.socket) -> None:
        self.sock = sock
        self.buf = bytearray()
        self.pos = 0
        self.closed = False
        self.read_bytes = 0

    def _pull(self) -> None:
        """One non-blocking gulp from the socket into the buffer."""
        if self.closed:
            return
        self.sock.settimeout(0.05)
        try:
            chunk = self.sock.recv(1460)  # one MTU, the size a board actually gets
        except socket.timeout:
            return
        except OSError:
            self.closed = True
            return
        if not chunk:
            self.closed = True
            return
        self.buf.extend(chunk)
        self.read_bytes += len(chunk)

    def available(self) -> int:
        if self.pos >= len(self.buf):
            self._pull()
        return len(self.buf) - self.pos

    def read(self) -> int:
        if self.available() <= 0:
            return -1
        byte = self.buf[self.pos]
        self.pos += 1
        return byte

    def connected(self) -> bool:
        if not self.closed:
            self._pull()
        return not self.closed

    def idle(self) -> None:
        time.sleep(0.001)


# ---------------------------------------------------------------------------
# The de-chunker, byte at a time, with the firmware's states
# ---------------------------------------------------------------------------


class _ChunkReader:
    """`gatelogic::ChunkReader`, state for state.

    Chunk extensions are skipped rather than parsed and trailer fields are skipped
    rather than collected, exactly as the firmware does, because nothing this
    product talks to sends either and a parser for a field nobody sends is a parser
    nothing tests.
    """

    MORE, DONE, MALFORMED, TOO_LARGE = "more", "done", "malformed", "too_large"

    def __init__(self, sink: bytearray, cap: int) -> None:
        self.sink = sink
        self.cap = cap
        self.state = "size"
        self.size = 0
        self.pending = 0
        self.digits = 0
        self.trailer_line = 0
        self.in_extension = False

    def done(self) -> bool:
        return self.state == "done"

    def feed(self, byte: int) -> str:
        handler = getattr(self, "_" + self.state)
        return handler(byte)

    # -- states ------------------------------------------------------------
    def _size(self, byte: int) -> str:
        if byte == 0x0D:  # CR
            # A size line with no digits at all is not a chunk header; accepting
            # one would read the next chunk's DATA as a size.
            if self.digits == 0:
                return self.MALFORMED
            self.state = "size_lf"
            return self.MORE
        if self.in_extension:
            return self.MORE
        if byte == 0x3B:  # ';'
            self.in_extension = True
            return self.MORE if self.digits else self.MALFORMED
        value = _hex_value(byte)
        if value > 15 or self.digits >= MAX_CHUNK_SIZE_DIGITS:
            return self.MALFORMED
        self.size = (self.size << 4) | value
        self.digits += 1
        return self.MORE

    def _size_lf(self, byte: int) -> str:
        if byte != 0x0A:
            return self.MALFORMED
        if self.size == 0:
            self.state = "trailer"
        else:
            self.state = "data"
            self.pending = self.size
        return self.MORE

    def _data(self, byte: int) -> str:
        if len(self.sink) + 1 >= self.cap:
            self.sink.clear()
            return self.TOO_LARGE
        self.sink.append(byte)
        self.pending -= 1
        if self.pending == 0:
            self.state = "data_cr"
        return self.MORE

    def _data_cr(self, byte: int) -> str:
        if byte != 0x0D:
            return self.MALFORMED
        self.state = "data_lf"
        return self.MORE

    def _data_lf(self, byte: int) -> str:
        if byte != 0x0A:
            return self.MALFORMED
        self.state = "size"
        self.size = 0
        self.digits = 0
        self.in_extension = False
        return self.MORE

    def _trailer(self, byte: int) -> str:
        if byte != 0x0D:
            self.trailer_line += 1
            return self.MORE
        self.state = "trailer_lf"
        return self.MORE

    def _trailer_lf(self, byte: int) -> str:
        if byte != 0x0A:
            return self.MALFORMED
        # An EMPTY trailer line ends the message; a non-empty one was a field.
        if self.trailer_line == 0:
            self.state = "done"
            return self.DONE
        self.trailer_line = 0
        self.state = "trailer"
        return self.MORE

    def _done(self, byte: int) -> str:  # noqa: ARG002 - the firmware has this arm too
        return self.DONE


def _hex_value(byte: int) -> int:
    if 0x30 <= byte <= 0x39:
        return byte - 0x30
    if 0x61 <= byte <= 0x66:
        return byte - 0x61 + 10
    if 0x41 <= byte <= 0x46:
        return byte - 0x41 + 10
    return 16


def frame_from_headers(content_length: Optional[int], chunked: bool) -> str:
    """`gatelogic::frameFromHeaders`. A Content-Length WINS over a chunked header.

    RFC 7230 §3.3.3 says to ignore the length when the transfer coding is chunked;
    this firmware talks to one API behind one proxy, and the safer reading of a
    self-contradictory response is the one that stops at a declared number of bytes
    rather than parsing framing that may not be there. Kept the same way round here
    so the harness cannot be more forgiving than the board.
    """
    if content_length is not None and content_length >= 0:
        return Framing.KNOWN_LENGTH
    return Framing.CHUNKED if chunked else Framing.UNTIL_CLOSE


def read_body(stream: _Stream, deadline: float, framing: str, length: int, cap: int) -> tuple[str, bytes]:
    """`gatelogic::readBody`: the whole body or nothing, never a truncated half.

    `deadline` is an absolute instant and is the BODY's own budget, sampled by the
    caller after the headers returned.
    """
    sink = bytearray()
    if framing == Framing.KNOWN_LENGTH and not 0 <= length < cap:
        # Refused before a byte is read: the peer has already said how long it is.
        return BodyResult.TOO_LARGE, b""
    chunks = _ChunkReader(sink, cap)

    def complete() -> bool:
        if framing == Framing.CHUNKED:
            return chunks.done()
        if framing == Framing.KNOWN_LENGTH:
            return len(sink) >= length
        # A body the peer never declared is over when the peer has hung up AND has
        # nothing left buffered: a closed socket with bytes still readable is the
        # end of the connection, not the end of the body.
        return not stream.connected() and stream.available() <= 0

    while not complete():
        if stream.available() > 0:
            byte = stream.read()
            if byte >= 0:
                if framing == Framing.CHUNKED:
                    step = chunks.feed(byte)
                    if step == _ChunkReader.MALFORMED:
                        return BodyResult.MALFORMED, b""
                    if step == _ChunkReader.TOO_LARGE:
                        return BodyResult.TOO_LARGE, b""
                else:
                    if len(sink) + 1 >= cap:
                        # NEVER TRUNCATED. `{"opened":true,` cut after the comma is
                        # a door that opens.
                        return BodyResult.TOO_LARGE, b""
                    sink.append(byte)
                continue

        # A CHUNKED body whose peer hung up before the zero-size line was cut, not
        # ended — reported rather than salvaged.
        if framing == Framing.CHUNKED and not stream.connected() and stream.available() <= 0:
            return BodyResult.MALFORMED, b""

        if time.monotonic() >= deadline:
            return BodyResult.TIMEOUT, b""
        stream.idle()

    return BodyResult.OK, bytes(sink)


# ---------------------------------------------------------------------------
# The client
# ---------------------------------------------------------------------------


@dataclass
class BoardHttp:
    """One board's HTTP, at one of the two versions a board can speak.

    **`version="1.0"` is what the shipped firmware asks for.** `Esp32Hal` calls
    `useHTTP10(true)` + `setReuse(false)` precisely so the body arrives
    close-delimited and the de-chunker never has to run in normal service.

    **`version="1.1"` is the belt-and-braces half**, and it keeps the socket open
    between calls on purpose: a keep-alive connection is what makes "read until the
    peer closes" hang for ever, which is the exact shape of G3's E1. A pass that
    opened a fresh socket per call would get the close for free and prove nothing.
    """

    host: str
    port: int
    version: str = "1.0"
    cap: int = RESPONSE_CAP
    label: str = "board"
    sock: Optional[socket.socket] = field(default=None, repr=False)
    #: Every response this client read, for the transcript a failure prints.
    log: list = field(default_factory=list, repr=False)

    @property
    def keep_alive(self) -> bool:
        return self.version == "1.1"

    def close(self) -> None:
        if self.sock is not None:
            try:
                self.sock.close()
            finally:
                self.sock = None

    def _connect(self) -> socket.socket:
        if self.keep_alive and self.sock is not None:
            return self.sock
        try:
            sock = socket.create_connection((self.host, self.port), timeout=CONNECT_BUDGET)
        except OSError as e:
            raise WireError(f"{self.label}: connect to {self.host}:{self.port} failed: {e}") from e
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        if self.keep_alive:
            self.sock = sock
        return sock

    def request(self, method: str, path: str, body: bytes = b"", headers: Optional[dict] = None) -> BoardResponse:
        """One request, read the board's way. Raises `WireError` only for the socket."""
        started = time.monotonic()
        try:
            return self._request(method, path, body, headers or {}, started)
        except WireError:
            self.close()
            raise
        except OSError as e:
            self.close()
            raise WireError(f"{self.label}: {method} {path}: {e}") from e

    def _request(self, method: str, path: str, body: bytes, headers: dict, started: float) -> BoardResponse:
        sock = self._connect()
        lines = [f"{method} {path} HTTP/{self.version}",
                 f"Host: {self.host}:{self.port}",
                 "User-Agent: crusaders-door-gate/e2e"]
        # HTTP/1.0 + `Connection: close` is the whole of the firmware's framing
        # request: a server may not chunk to a 1.0 client, so the body arrives
        # close-delimited. 1.1 says keep-alive so the socket stays open and a
        # reader that guessed "until close" would wait for ever.
        lines.append("Connection: close" if self.version == "1.0" else "Connection: keep-alive")
        for name, value in headers.items():
            lines.append(f"{name}: {value}")
        if body:
            lines.append(f"Content-Length: {len(body)}")
        request = ("\r\n".join(lines) + "\r\n\r\n").encode("ascii") + body
        sock.sendall(request)

        stream = _Stream(sock)
        head = self._read_head(stream, time.monotonic() + HEADER_BUDGET)
        if head is None:
            resp = BoardResponse(0, 0, "", "", {}, b"", Framing.UNTIL_CLOSE, BodyResult.TIMEOUT,
                                 elapsed_ms=int((time.monotonic() - started) * 1000))
            self._finish(method, path, body, resp)
            return resp

        version, http_status, phrase, hdrs = head
        content_length = _int_or_none(hdrs.get("content-length"))
        chunked = "chunked" in (hdrs.get("transfer-encoding") or "").lower()
        framing = frame_from_headers(content_length, chunked)
        # A status that carries no body at all, whatever the framing says.
        if http_status in (204, 304) or method == "HEAD":
            framing, content_length = Framing.KNOWN_LENGTH, 0

        # THE BODY'S OWN BUDGET, SAMPLED HERE. Not at `started` — that is the bug
        # round G2 shipped, and a header phase that spent its budget would leave
        # this deadline already in the past.
        body_deadline = time.monotonic() + BODY_BUDGET
        result, payload = read_body(stream, body_deadline, framing, content_length or 0, self.cap)

        if not self.keep_alive or result != BodyResult.OK or _closing(hdrs):
            self.close()
            if sock is not self.sock:
                try:
                    sock.close()
                except OSError:
                    pass

        resp = BoardResponse(
            status=http_status if result == BodyResult.OK else 0,  # gatelogic::statusForBody
            http_status=http_status, reason_phrase=phrase, version=version, headers=hdrs,
            body=payload, framing=framing, body_result=result,
            elapsed_ms=int((time.monotonic() - started) * 1000),
            wire_bytes=stream.read_bytes,
        )
        resp.text = payload.decode("utf-8", "replace")
        try:
            resp.json = json.loads(resp.text) if resp.text.strip() else None
        except json.JSONDecodeError:
            resp.json = None
        self._finish(method, path, body, resp)
        return resp

    def _finish(self, method: str, path: str, body: bytes, resp: BoardResponse) -> None:
        self.log.append((self.label, method, path, body.decode("utf-8", "replace")[:400], resp))
        del self.log[:-40]

    def _read_head(self, stream: _Stream, deadline: float) -> Optional[tuple]:
        """Status line and headers, byte at a time, bounded by the header budget."""
        raw = bytearray()
        while b"\r\n\r\n" not in raw:
            if stream.available() > 0:
                byte = stream.read()
                if byte >= 0:
                    raw.append(byte)
                    if len(raw) > self.cap:
                        return None
                    continue
            if not stream.connected() and stream.available() <= 0:
                return None
            if time.monotonic() >= deadline:
                return None
            stream.idle()

        text = bytes(raw).split(b"\r\n\r\n", 1)[0].decode("iso-8859-1")
        lines = text.split("\r\n")
        parts = lines[0].split(" ", 2)
        if len(parts) < 2 or not parts[0].startswith("HTTP/"):
            return None
        version = parts[0][5:]
        try:
            status = int(parts[1])
        except ValueError:
            return None
        phrase = parts[2] if len(parts) > 2 else ""
        hdrs: dict = {}
        for line in lines[1:]:
            if ":" not in line:
                continue
            name, _, value = line.partition(":")
            hdrs[name.strip().lower()] = value.strip()
        return version, status, phrase, hdrs


def _int_or_none(text: Optional[str]) -> Optional[int]:
    try:
        return int(text) if text is not None else None
    except ValueError:
        return None


def _closing(headers: dict) -> bool:
    return "close" in (headers.get("connection") or "").lower()
