import subprocess, struct, math, time, sys
def meas(tag, secs=4):
    subprocess.run(f"timeout {secs} candump -ta can1 > E5_{tag}.raw 2>&1", shell=True)
    fr=[]
    for line in open(f"E5_{tag}.raw"):
        p=line.split()
        if len(p)<4 or p[2]!="052": continue
        fr.append(bytes(int(x,16) for x in p[4:4+int(p[3].strip('[]'))]))
    if not fr: return 0,0,0,0
    pos=[struct.unpack(">21h",x[:42]) for x in fr]
    rng=max(math.degrees((max(p[g*3] for p in pos)-min(p[g*3] for p in pos))/4700.0) for g in range(7))
    eff=max(abs(p[g*3+2])/600.0 for p in pos for g in range(7))
    return len(fr), len(set(fr)), rng, eff
def ff(c):
    assert 1<=c<=6
    subprocess.run(f"cansend can1 053#{c:02X}", shell=True, check=True)
    time.sleep(1.0)
print(f"{'state':<22}{'frames':>7}{'distinct':>10}{'posrng':>9}{'|eff|max':>10}  telemetry")
for code,label in [(1,"enable (1)"),(3,"release (3)"),(1,"enable (1) again"),
                   (4,"release (4)"),(1,"enable (1) final")]:
    ff(code)
    n,d,r,e = meas(label.split()[0]+str(code)+"_"+str(time.time())[-3:])
    print(f"{label:<22}{n:>7}{d:>10}{r:>8.2f}°{e:>10.3f}  {'LIVE' if d>1 else 'FROZEN'}")
