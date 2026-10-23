import json, os, time, urllib.request
key = os.environ["GROQ_API_KEY"]
def call(model, prompt):
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": prompt}], "max_tokens": 600}).encode()
    req = urllib.request.Request("https://api.groq.com/openai/v1/chat/completions", body,
        {"Authorization": f"Bearer {key}", "Content-Type": "application/json", "User-Agent": "bench"})
    t = time.time()
    with urllib.request.urlopen(req) as r:
        h = dict(r.headers); d = json.load(r)
    wall = time.time() - t
    u = d["usage"]
    return wall, u, h
for m in ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.8-27b"]:
    try:
        wall, u, h = call(m, "Write a 200-word explanation of how tides work.")
        ct = u["completion_tokens"]; ctime = u.get("completion_time") or wall
        print(f"{m:24} wall={wall:.2f}s in={u['prompt_tokens']} out={ct} server_tps={ct/ctime:.0f} wall_tps={ct/wall:.0f}  TPM_limit={h.get('x-ratelimit-limit-tokens')} RPM/RPD_limit={h.get('x-ratelimit-limit-requests')}")
    except Exception as e:
        print(m, "ERR", getattr(e, "read", lambda: str(e))()[:300])
