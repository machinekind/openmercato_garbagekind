"""J1-only compliance: setpoint chases J1, all other joints held rigid.

J1 is base yaw -- no gravity load -- so it can have a wide range with no
risk of the arm falling. That removes the leash that confounded every
previous attempt. Question: when you let go, does J1 STAY, or spring back?
"""
import socket, struct, sys, time, math
IFACE="can0"; SECS=float(sys.argv[1]) if len(sys.argv)>1 else 25.0
KP=float(sys.argv[2]) if len(sys.argv)>2 else 20.0
KD=float(sys.argv[3]) if len(sys.argv)>3 else 1.0
RANGE=math.radians(50.0); ABORT=math.radians(55.0); VMAX=math.radians(120.0)
RATE_LIM=math.radians(180.0)
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
s.setsockopt(socket.SOL_CAN_RAW,socket.CAN_RAW_FD_FRAMES,1); s.bind((IFACE,)); s.settimeout(0.02)
def drain(timeout=0.5):
    end=time.time()+timeout; got=None; n=0
    while True:
        try: b=s.recv(72)
        except socket.timeout:
            if got is not None or time.time()>end: return got,n
            continue
        if (struct.unpack("=I",b[:4])[0]&0x1FFFFFFF)!=0x052: continue
        v=struct.unpack(">21h",b[8:8+42])
        got=([v[g*3]/4700.0 for g in range(7)],[v[g*3+1]/750.0 for g in range(7)],
             [v[g*3+2]/600.0 for g in range(7)]); n+=1
        s.settimeout(0.0)
        try:
            while True:
                b=s.recv(72)
                if (struct.unpack("=I",b[:4])[0]&0x1FFFFFFF)!=0x052: continue
                v=struct.unpack(">21h",b[8:8+42])
                got=([v[g*3]/4700.0 for g in range(7)],[v[g*3+1]/750.0 for g in range(7)],
                     [v[g*3+2]/600.0 for g in range(7)]); n+=1
        except BlockingIOError: pass
        except socket.timeout: pass
        s.settimeout(0.02)
        return got,n
st,_=drain(2.0)
if st is None: print("  no feedback"); raise SystemExit(1)
start=st[0][:6]; base=start[0]
p_des=list(start)
print(f"  J1 start {math.degrees(base):+.2f} deg   kp={KP} kd={KD}   range +/-50 deg")
print(f"  --- SWING J1 BY HAND, THEN LET GO AND WATCH ---")
t0=time.time(); n_tx=0; n_rx=0; peak=0.0; hum=[]; last=start[0]; prev=time.time()
reason="completed"
while time.time()-t0<SECS:
    got,k=drain(0.01)
    if got:
        q,v,e=got; n_rx+=k; last=q[0]
        peak=max(peak,abs(q[0]-base)); hum.append(e[0])
        if abs(q[0]-base)>ABORT: reason="ABORT: past 55 deg"; break
        if abs(v[0])>VMAX: reason=f"ABORT: J1 velocity {math.degrees(v[0]):.0f} deg/s"; break
        now=time.time(); dt=max(1e-3,now-prev); prev=now
        tgt=max(base-RANGE,min(base+RANGE,q[0]))
        step=RATE_LIM*dt
        p_des[0]+= max(-step,min(step,tgt-p_des[0]))
    s.send(struct.pack("=IBBBB",0x050,60,0x01,0,0)+encode(p_des,[0.0]*6,[KP]*6,[KD]*6,[0.0]*6).ljust(64,b"\x00")); n_tx+=1
    time.sleep(1/200.0)
print(f"\n  {reason}   tx={n_tx} rx={n_rx}  telemetry {'LIVE' if n_rx>500 else 'STALLED'}")
print(f"  peak J1 excursion from start: {math.degrees(peak):.2f} deg")
print(f"  J1 at end of stream:          {math.degrees(last):+.2f} deg")
print(f"  mean |effort| J1 while moving: {sum(abs(x) for x in hum)/max(1,len(hum)):.2f}")
time.sleep(1.5)
got,_=drain(1.0)
if got: print(f"  1.5s after stream stopped:    {math.degrees(got[0][0]):+.2f} deg  <- did it stay?")
