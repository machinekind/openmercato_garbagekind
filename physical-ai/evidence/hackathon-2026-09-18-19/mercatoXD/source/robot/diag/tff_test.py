"""Does t_ff do anything? Prediction: with p_des fixed and kp>0, the joint
settles where kp*(p_des-p) = -t_ff, i.e. offset = t_ff/kp. Linear in t_ff.

J1 (base yaw, no gravity load). Samples DURING the stream and drains the
socket every cycle -- the two mistakes that produced false negatives earlier.
"""
import socket, struct, time, math
KP, KD = 20.0, 1.0
FIELDS=((-6.5,6.5,4700.0),(-40.0,40.0,750.0),(0.0,500.0,60.0),(0.0,200.0,150.0),(-50.0,50.0,600.0))
def encode(p,v,kp,kd,t):
    out=bytearray(60)
    for j in range(6):
        for k,vals in enumerate((p,v,kp,kd,t)):
            lo,hi,sc=FIELDS[k]; x=max(lo,min(hi,vals[j]))
            raw=max(-32768,min(32767,int(x*sc))); off=j*10+k*2
            out[off]=(raw>>8)&0xFF; out[off+1]=raw&0xFF
    return bytes(out)
s=socket.socket(socket.AF_CAN,socket.SOCK_RAW,socket.CAN_RAW)
s.setsockopt(socket.SOL_CAN_RAW,socket.CAN_RAW_FD_FRAMES,1); s.bind(("can0",)); s.settimeout(0.0)
q=e=None
def drain():
    global q,e
    ok=False
    while True:
        try: b=s.recv(72)
        except (BlockingIOError,socket.timeout): break
        if (struct.unpack("=I",b[:4])[0]&0x1FFFFFFF)!=0x052: continue
        r=struct.unpack(">21h",b[8:8+42])
        q=[r[g*3]/4700.0 for g in range(7)]; e=[r[g*3+2]/600.0 for g in range(7)]; ok=True
    return ok
t0=time.time()
while not drain() and time.time()-t0<3: time.sleep(0.002)
anchor=list(q[:6])

def hold(tff_j1, secs):
    """Stream p_des=anchor with a given t_ff on J1. Return settled pos+effort."""
    t=[0.0]*6; t[0]=tff_j1
    t0=time.time(); last=[]
    while time.time()-t0<secs:
        s.send(struct.pack("=IBBBB",0x050,60,0x01,0,0)
               + encode(anchor,[0.0]*6,[KP]*6,[KD]*6,t).ljust(64,b"\x00"))
        drain()
        if time.time()-t0>secs*0.6: last.append((q[0],e[0]))
        time.sleep(1/200.0)
    return (sum(x[0] for x in last)/len(last), sum(x[1] for x in last)/len(last))

# acceptance check: does the arm obey at all right now?
p2=list(anchor); p2[0]=anchor[0]+math.radians(2.0)
t0=time.time()
while time.time()-t0<2.0:
    s.send(struct.pack("=IBBBB",0x050,60,0x01,0,0)+encode(p2,[0.0]*6,[KP]*6,[KD]*6,[0.0]*6).ljust(64,b"\x00"))
    drain(); time.sleep(1/200.0)
acc=math.degrees(abs(q[0]-anchor[0]))
print(f"  acceptance: commanded J1 +2.00 deg -> moved {acc:.2f} deg "
      f"({'OK' if acc>1.0 else 'ARM NOT LISTENING -- results below are meaningless'})\n")
hold(0.0, 1.5)
base,_ = hold(0.0, 2.0)
print(f"  {'t_ff (Nm)':>10} {'J1 offset':>11} {'predicted':>11} {'effort':>9}")
print(f"  {'-'*10} {'-'*11} {'-'*11} {'-'*9}")
for tff in (0.0, 1.0, 2.0, -1.0, -2.0):
    pos,eff = hold(tff, 2.5)
    off = math.degrees(pos-base); pred = math.degrees(tff/KP)
    print(f"  {tff:10.1f} {off:10.2f}d {pred:10.2f}d {eff:9.2f}")
hold(0.0, 1.5)
print(f"\n  If offsets track 'predicted', t_ff WORKS and gravity comp is available.")
