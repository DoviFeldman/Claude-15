import json, sys, time, urllib.request
"""ask.py "question" [chat] -> reply + timing/token stats from the local chat-bridge endpoint."""
body = json.dumps({"text": sys.argv[1], "chat": sys.argv[2] if len(sys.argv) > 2 else "local"}).encode()
t = time.time()
d = json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:3999/chat", body, {"Content-Type": "application/json"}), timeout=300))
s = d.get("stats") or {}
print("Q:", sys.argv[1]); print("A:", d.get("reply", d))
print(f"   {d.get('ms')} ms | steps={s.get('steps')} in_tokens={s.get('input')} out_tokens={s.get('output')} tools={s.get('tools')}\n")
