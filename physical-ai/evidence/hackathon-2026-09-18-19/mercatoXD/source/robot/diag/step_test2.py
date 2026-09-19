"""Same step, but sample DURING the stream, and watch all 7 groups."""
import socket, struct, sys, time, math
IFACE=sys.argv[1] if len(sys.argv)>1 else "can0"
STEP=math.radians(float(sys.argv[2]) if len(sys.argv)>2 else 2.0)
KP=float(sys.argv[3]) if len(sys.argv)>3 else 20.0
KD=float(sys.argv[4]) if len(sys.argv)>4 else 1.0
FIELDS=((-6.5,6.5,4700.0),(-40.0,40.0,750.0),(0.0,500.0,60.0),(0.0,200.0,150.0),(-50.0,50.0,600.0))
def encode(p,v,kp,kd,t):
    out=bytearray(60)
    for j in range(6):
        for k,vals in enumerate((p,v,kp,kd,t)):
            lo,hi,sc=FIELDS[k]; x=max(lo,min(hi,vals[j]))
            raw=max(-32768,min(32767,int(x*sc))); off=j*10+k*2
            out[off]=(raw>>8)&0xFF; out[off+1]=raw&0xFF
    return bytes(out)
def send(s,cid,p):
    n=len(p)
    if n<=8: s.send(struct.pack("=IBBBB",cid,n,0,0,0)+p.ljust(8,b"\x00"))
    else:    s.send(struct.pack("=IBBBB",cid,n,0x01,0,0)+p.ljust(64,b"\x00"))
s=socket.socket(socket.AF_CAN,socket.SOCK_RAW,socket.CAN_RAW)
s.setsockopt(socket.SOL_CAN_RAW,socket.CAN_RAW_FD_FRAMES,1); s.bind((IFACE,)); s.settimeout(0.02)
def q7(timeout=0.5):
    end=time.time()+timeout
    while time.time()<end:
        try: b=s.recv(72)
        except socket.timeout: continue
        if (struct.unpack("=I",b[:4])[0]&0x1FFFFFFF)!=0x052: continue
        v=struct.unpack(">21h",b[8:8+42]); return [v[g*3]/4700.0 for g in range(7)]
    return None
def d(v): return [round(math.degrees(x),3) for x in v]

start=q7(2.0)
print(f"  start   (7 groups, deg): {d(start)}")
tgt=[start[i] for i in range(6)]; tgt[0]=start[0]+STEP
print(f"  commanding cmd-joint 0 by {math.degrees(STEP):+.2f} deg for 2.5s, sampling THROUGHOUT\n")
t0=time.time(); n=0; peak=[0.0]*7; last=None
while time.time()-t0<2.5:
    send(s,0x050,encode(tgt,[0.0]*6,[KP]*6,[KD]*6,[0.0]*6)); n+=1
    cur=q7(0.01)
    if cur:
        last=cur
        for g in range(7): peak[g]=max(peak[g],abs(cur[g]-start[g]))
    time.sleep(1/200.0)
print(f"  sent {n} frames")
print(f"  DURING stream, last sample: {d(last)}")
print(f"  peak |delta| per group:     {d(peak)}")
mover=max(range(7), key=lambda g: peak[g])
print(f"  -> largest mover: GROUP {mover+1}  ({math.degrees(peak[mover]):.2f} deg)\n")
time.sleep(0.6)
after=q7(1.0)
print(f"  0.6s AFTER stream stopped:  {d(after)}")
print(f"  reverted by: {d([after[g]-last[g] for g in range(7)])}")
