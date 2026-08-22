import io, os

for name in ("README-zh.md", "README.md"):
    with io.open(name, encoding="utf-8") as f:
        c = f.read()
    print(name, "chars:", len(c), "bytes:", os.path.getsize(name))
    tail = c[9000:]
    out = "_tail_" + ("zh" if "zh" in name else "en") + ".md"
    with io.open(out, "w", encoding="utf-8") as g:
        g.write(tail)
    print("wrote", out, len(tail), "chars")