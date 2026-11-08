path = "crates/freshell-protocol/tests/inventory.rs"
s = open(path).read()

MARK_S = "<<<<<<< HEAD\n"
MARK_E = ">>>>>>> 4625868f162b9c4c99e5b0a04204e6f10da9e2d8\n"

out = []
i = 0
while True:
    a = s.find(MARK_S, i)
    if a < 0:
        out.append(s[i:])
        break
    out.append(s[i:a])
    b = s.find("=======\n", a)
    c = s.find(MARK_E, b)
    head = s[a + len(MARK_S):b]
    theirs = s[b + len("=======\n"):c]

    if "Some(41)" in head or "Some(67)" in head or "combined_surface_is_108" in head:
        chosen = head  # counts already normalized to the merged totals
    elif head.strip() == "104,":
        chosen = head.replace("104,", "108,")
    else:
        raise SystemExit("UNRECOGNIZED CONFLICT:\nHEAD:\n" + head + "\nTHEIRS:\n" + theirs)
    out.append(chosen)
    i = c + len(MARK_E)

open(path, "w").write("".join(out))
print("resolved")
