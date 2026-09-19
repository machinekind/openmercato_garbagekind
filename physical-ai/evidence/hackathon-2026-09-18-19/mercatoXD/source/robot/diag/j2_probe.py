"""Why won't J2 backdrive? Log its setpoint, position, error and effort.

Large error  -> our p_des is not tracking; our problem.
Error ~0 + high effort -> the arm is applying its own feedforward torque.
"""
import socket, struct, time, math, sys
IFACE="can0"; SECS=float(sys.argv[1]) if len(sys.argv)>1 else 20.0
KP=float(sys.argv[2]) if len(sys.argv)>2 else 20.0; KD=0.0
J=1                                   # J2, zero-indexed
LEASH=math.radians(60.0)
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
s.setsockopt(socket.SOL_CAN_RAW,socket.CAN_RAW_FD_FRAMES,1); s.bind((IFACE,)); s.settimeout(0.0)
q=v=e=None
def drain():
    global q,v,e
    got=False
    while True:
        try: b=s.recv(72)
        except (BlockingIOError,socket.timeout): break
        if (struct.unpack("=I",b[:4])[0]&0x1FFFFFFF)!=0x052: continue
        r=struct.unpack(">21h",b[8:8+42])
        q=[r[g*3]/4700.0 for g in range(7)]; v=[r[g*3+1]/750.0 for g in range(7)]
        e=[r[g*3+2]/600.0 for g in range(7)]; got=True
    return got
t0=time.time()
while not drain() and time.time()-t0<3: time.sleep(0.002)
start=list(q[:6]); p=list(start)
print(f"  J2 start {math.degrees(start[J]):+.2f} deg   kp={KP} kd=0   leash +/-60 deg")
print(f"  --- TRY TO MOVE J2 (the shoulder) FOR {SECS:.0f}s ---\n")
rows=[]; t0=time.time(); nxt=t0
while time.time()-t0<SECS:
    drain()
    for j in range(6):
        p[j]=max(start[j]-LEASH,min(start[j]+LEASH,q[j]))
    now=time.time()
    if now>=nxt:
        nxt=now+1/200.0
        s.send(struct.pack("=IBBBB",0x050,60,0x01,0,0)+encode(p,[0.0]*6,[KP]*6,[KD]*6,[0.0]*6).ljust(64,b"\x00"))
        rows.append((now-t0,q[J],p[J],e[J],v[J]))
    time.sleep(0.0005)
err=[abs(r[1]-r[2]) for r in rows]; eff=[abs(r[3]) for r in rows]
mv=math.degrees(max(r[1] for r in rows)-min(r[1] for r in rows))
clamped=sum(1 for r in rows if abs(r[2]-(start[J]+math.copysign(LEASH,r[2]-start[J])))<1e-9)
print(f"  samples {len(rows)}")
print(f"  J2 travelled            : {mv:.2f} deg")
print(f"  |q - p_des| mean / max  : {math.degrees(sum(err)/len(err)):.3f} / {math.degrees(max(err)):.3f} deg")
print(f"  |effort| mean / max     : {sum(eff)/len(eff):.2f} / {max(eff):.2f}")
print(f"  peak |velocity|         : {math.degrees(max(abs(r[4]) for r in rows)):.1f} deg/s")
print(f"  samples with p_des at leash: {clamped}")
with open("j2_probe.csv","w") as f:
    f.write("t,q_deg,p_des_deg,effort,vel_deg_s\n")
    for r in rows: f.write(f"{r[0]:.4f},{math.degrees(r[1]):.4f},{math.degrees(r[2]):.4f},{r[3]:.4f},{math.degrees(r[4]):.3f}\n")
print("  raw -> diag/j2_probe.csv")
me = math.degrees(sum(err)/len(err))
print(f"\n  -> {'SETPOINT NOT TRACKING (our bug)' if me>1.0 else 'setpoint tracks; resistance is the ARM feedforward/friction, not position error'}")
