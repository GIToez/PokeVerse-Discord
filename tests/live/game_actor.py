#!/usr/bin/env python3
"""Real game clients for the live tests, controlled over stdin/stdout (JSON lines).

Uses scripts/protocol-test.py from the PokeVerse game repository (PV_GAME_REPO) to log
characters in and to talk, so the live tests exercise the real game server end to end.

Commands: {"id", "op", ...}
  login        player, account, password, character
  open_channel player, channel
  say          player, text
  say_channel  player, channel, text
  wait_for     player, needle, timeout  -> {"found": bool}
  command      player, text, seconds    -> {"text": everything the server sent meanwhile}
  logout       player (normal logout, like the client's logout button)
  clear        player
  quit
"""
import importlib.util
import json
import os
import socket
import struct
import sys
import threading
import time

repo = os.environ["PV_GAME_REPO"]
spec = importlib.util.spec_from_file_location("protocol_test", os.path.join(repo, "scripts", "protocol-test.py"))
pt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pt)


class Player:
    def __init__(self, account, password, character):
        args = type("Args", (), {})()
        args.host = os.environ.get("PV_GAME_HOST", "127.0.0.1")
        args.login_port = int(os.environ.get("PV_LOGIN_PORT", "7564"))
        args.account, args.password, args.character, args.timeout = account, password, character, 30
        chars = pt.login(args)
        _, _, _, port = [c for c in chars if c[0] == character][0]
        self.conn, self.id, self.pos = pt.enter_game(args, args.host, port)
        self.packets = []
        self.lock = threading.Lock()
        self.running = True
        self.thread = threading.Thread(target=self.reader, daemon=True)
        self.thread.start()
        threading.Thread(target=self.keepalive, daemon=True).start()

    def keepalive(self):
        # The server logs out clients that never answer its pings after a few idle minutes.
        while self.running:
            time.sleep(10)
            try:
                self.send(b"\x1e")
            except Exception:
                break

    def reader(self):
        self.conn.sock.settimeout(0.5)
        while self.running:
            try:
                data = self.conn.recv()
                if data:
                    with self.lock:
                        self.packets.append(data)
            except socket.timeout:
                continue
            except Exception:
                break

    def send(self, payload):
        self.conn.send(payload)

    def wait_for(self, needle, timeout):
        end = time.time() + timeout
        while time.time() < end:
            with self.lock:
                if any(needle in packet for packet in self.packets):
                    return True
            time.sleep(0.1)
        return False

    def command(self, text, seconds):
        with self.lock:
            start = len(self.packets)
        self.send(struct.pack("<BB", 0x96, 1) + pt.pstr(text))
        time.sleep(seconds)
        with self.lock:
            # Replies can be bundled with other packets, so search everything received.
            return b"\n".join(self.packets[start:]).decode("latin-1")

    def close(self):
        self.running = False
        self.conn.close()


players = {}


def handle(command):
    op = command["op"]
    if op == "login":
        players[command["player"]] = Player(command["account"], command["password"], command["character"])
        return {}
    if op == "quit":
        for player in players.values():
            player.close()
        return {"quit": True}
    player = players[command["player"]]
    if op == "open_channel":
        player.send(struct.pack("<BH", 0x98, command["channel"]))
    elif op == "say":
        player.send(struct.pack("<BB", 0x96, 1) + pt.pstr(command["text"]))
    elif op == "say_channel":
        player.send(struct.pack("<BBH", 0x96, 7, command["channel"]) + pt.pstr(command["text"]))
    elif op == "wait_for":
        return {"found": player.wait_for(command["needle"].encode("latin-1"), command.get("timeout", 5))}
    elif op == "wait_for_channel_message":
        # Channel message packet as sent by the game: author, statement id, speak class, channel, text.
        # The client shows it as "<author>: <text>".
        needle = (pt.pstr(command["author"]) + struct.pack("<HBH", 0, command.get("speakClass", 7), command["channel"])
                  + pt.pstr(command["text"]))
        return {"found": player.wait_for(needle, command.get("timeout", 5))}
    elif op == "command":
        return {"text": player.command(command["text"], command.get("seconds", 1.5))}
    elif op == "logout":
        player.send(b"\x14")
    elif op == "clear":
        with player.lock:
            player.packets.clear()
    else:
        raise ValueError("unknown op " + op)
    return {}


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    command = json.loads(line)
    try:
        result = handle(command)
        reply = {"id": command.get("id"), "ok": True}
        reply.update(result)
    except Exception as error:  # reported to the test, which fails with the message
        reply = {"id": command.get("id"), "ok": False, "error": "%s: %s" % (type(error).__name__, error)}
    sys.stdout.write(json.dumps(reply) + "\n")
    sys.stdout.flush()
    if reply.get("quit"):
        break
