import subprocess, sys, struct, math, time
def capture(iface, secs, tag):
    f=f"E5_{tag}.raw"
    subprocess.run(f"timeout {secs} candump -ta {iface} > {f} 2>&1", shell=True)
    fr=[]
    for line in open(f):
        p=line.split()
        if len(p)<4 or p[2]!="052": continue
        try: n=int(p[3].strip("[]"))
        except: continue
        fr.append(bytes(int(x,16) for x in p[4:4+n]))
    if not fr: return (0,0,0.0,0.0,f)
    pos=[struct.unpack(">21h",x[:42]) for x in fr]
    rng=max(math.degrees((max(p[g*3] for p in pos)-min(p[g*3] for p in pos))/4700.0) for g in range(7))
    eff=max(abs(p[g*3+2])/600.0 for p in pos for g in range(7))
    return (len(fr), len(set(fr)), rng, eff, f)

iface=sys.argv[1]
codes=[int(c) for c in sys.argv[2:]]
print(f"{'step':<14}{'frames':>7}{'distinct':>10}{'posrange':>10}{'|eff|max':>10}   telemetry")
n,d,r,e,f = capture(iface, 3, "baseline")
print(f"{'baseline':<14}{n:>7}{d:>10}{r:>9.2f}°{e:>10.3f}   {'LIVE' if d>1 else 'FROZEN'}")
for c in codes:
    assert 1 <= c <= 6, "codes above 6 are forbidden"
    subprocess.run(f"cansend {iface} 053#{c:02X}", shell=True, check=True)
    time.sleep(1.0)
    n,d,r,e,f = capture(iface, 4, f"code{c}")
    print(f"{'after FF '+str(c):<14}{n:>7}{d:>10}{r:>9.2f}°{e:>10.3f}   {'LIVE' if d>1 else 'FROZEN'}")
