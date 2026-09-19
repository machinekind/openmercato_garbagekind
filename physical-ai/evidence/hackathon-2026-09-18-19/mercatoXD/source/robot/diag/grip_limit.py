"""How far does the A1X gripper open before it hits its stop?
Steps p_des further open, watching for position to saturate (= mechanical
stop) and for effort to climb (= stalling against it). Backs off immediately."""
import socket, struct, time, math
FIELDS=((-6.5,6.5,4700.0),(-40.0,40.0,750.0),(0.0,500.0,60.0),(0.0,200.0,150.0),(-50.0,50.0,600.0))
def enc(p,v,kp,kd,t):
    out=bytearray(10)
    for k,val in enumerate((p,v,kp,kd,t)):
        lo,hi,sc=FIELDS[k]; x=max(lo,min(hi,val))
        raw=max(-32768,min(32767,int(x*sc))); out[k*2]=(raw>>8)&0xFF; out[k*2+1]=raw&0xFF
    return bytes(out)
s=socket.socket(socket.AF_CAN,socket.SOCK_RAW,socket.CAN_RAW)
s.setsockopt(socket.SOL_CAN_RAW,socket.CAN_RAW_FD_FRAMES,1); s.bind(("can0",)); s.settimeout(0.0)
g=None
def drain():
    global g
    while True:
        try: b=s.recv(72)
        except (BlockingIOError,socket.timeout): break
        if (struct.unpack("=I",b[:4])[0]&0x1FFFFFFF)!=0x052: continue
        r=struct.unpack(">21h",b[8:8+42]); g=(r[18]/4700.0, r[20]/600.0)
t0=time.time()
while g is None and time.time()-t0<3: drain(); time.sleep(0.002)
def hold(p,secs=2.5):
    t0=time.time(); em=0.0
    while time.time()-t0<secs:
        s.send(struct.pack("=IBBBB",0x051,10,0x01,0,0)+enc(p,0.0,25.0,1.0,0.0).ljust(64,b"\x00"))
        drain(); em=max(em,abs(g[1])); time.sleep(1/200.)
    return math.degrees(g[0]), em
prev=None
print(f"  {'p_des':>7} {'position':>10} {'gain vs prev':>13} {'|eff|max':>9}")
for p in (-1.0,-1.5,-2.0,-2.5,-3.0):
    pos,em=hold(p)
    delta = "" if prev is None else f"{pos-prev:+9.2f} deg"
    print(f"  {p:7.2f} {pos:9.2f}d {delta:>13} {em:9.2f}")
    if prev is not None and abs(pos-prev) < 2.0:
        print(f"  -> saturated: further opening gains nothing. STOP at {p:+.2f}")
        break
    if em > 12.0:
        print(f"  -> effort climbing ({em:.1f}); stalling against the stop. STOP.")
        break
    prev=pos
print("  returning to a neutral open position")
hold(-1.5,1.5)
