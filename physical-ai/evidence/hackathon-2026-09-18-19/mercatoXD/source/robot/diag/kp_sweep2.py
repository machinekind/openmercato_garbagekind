"""Lowest per-joint kp the arm ACCEPTS -- rerun on a verified-healthy arm.
Varies kp on J4 only; J1 is commanded +2 deg at normal kp as the acceptance
probe. J1 moving => the frame was processed."""
import socket, struct, time, math
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
q=None
def drain():
    global q
    while True:
        try: b=s.recv(72)
        except (BlockingIOError,socket.timeout): break
        if (struct.unpack("=I",b[:4])[0]&0x1FFFFFFF)!=0x052: continue
        r=struct.unpack(">21h",b[8:8+42]); q=[r[g*3]/4700.0 for g in range(7)]
t0=time.time()
while q is None and time.time()-t0<3: drain(); time.sleep(0.002)
def hold(p,kp,kd,secs):
    t0=time.time()
    while time.time()-t0<secs:
        s.send(struct.pack("=IBBBB",0x050,60,0x01,0,0)+encode(p,[0.]*6,kp,kd,[0.]*6).ljust(64,b"\x00"))
        drain(); time.sleep(1/200.)
print(f"  {'kp[J4]':>8} {'raw':>5} {'J1 probe':>10} {'J4 drift':>10}  frame")
for kp4 in (20.0, 5.0, 2.0, 1.0, 0.5, 0.1, 0.017, 0.0):
    drain(); start=list(q[:6]); p=list(start); p[0]=start[0]+math.radians(2.0)
    kp=[20.]*6; kd=[1.]*6; kp[3]=kp4
    hold(p,kp,kd,2.2); drain()
    j1=math.degrees(abs(q[0]-start[0])); j4=math.degrees(abs(q[3]-start[3]))
    print(f"  {kp4:8.3f} {int(kp4*60):>5} {j1:9.2f}d {j4:9.2f}d  "
          f"{'ACCEPTED' if j1>1.0 else 'DISCARDED'}")
    hold(start,[20.]*6,[1.]*6,1.5)
