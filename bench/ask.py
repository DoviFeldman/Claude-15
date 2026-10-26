import json, sys, time, urllib.request
"""ask.py "question" [chat] -> reply + timing/token/route stats from the local chat-bridge endpoint."""
body = json.dumps({"text": sys.argv[1], "chat": sys.argv[2] if len(sys.argv) > 2 else "local"}).encode()
d = json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:3999/chat", body, {"Content-Type": "application/json"}), timeout=400))
s = d.get("stats") or {}
r = s.get("route") or {}
print("Q:", sys.argv[1]); print("A:", d.get("reply", d))
if s.get("steps") is not None:
    print(f"   {d.get('ms')} ms | calls={s.get('steps')} in={s.get('input')} out={s.get('output')} tools={s.get('tools')} | packs={r.get('packs')} via {r.get('by')}\n")
