"""Does the A1X gripper open on a negative p_des? Watch group 7 feedback."""
import socket, struct, time, math
FIELDS=((-6.5,6.5,4700.0),(-40.0,40.0,750.0),(0.0,500.0,60.0),(0.0,200.0,150.0),(-50.0,50.0,600.0))
def enc_grip(p,v,kp,kd,t):
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
        r=struct.unpack(">21h",b[8:8+42]); g=(r[18]/4700.0, r[19]/750.0, r[20]/600.0)
t0=time.time()
while g is None and time.time()-t0<3: drain(); time.sleep(0.002)
print(f"  gripper at rest: pos={math.degrees(g[0]):+7.2f}  eff={g[2]:+.2f}")
def hold(p,kp,secs,tag):
    t0=time.time(); peak=0.0
    while time.time()-t0<secs:
        s.send(struct.pack("=IBBBB",0x051,10,0x01,0,0)+enc_grip(p,0.0,kp,1.0,0.0).ljust(64,b"\x00"))
        drain(); peak=max(peak,abs(g[2])); time.sleep(1/200.)
    print(f"  {tag:<28} p_des={p:+.2f} kp={kp:<5g} -> pos={math.degrees(g[0]):+7.2f}  |eff|max={peak:.2f}")
    return g[0]
base=g[0]
for p,kp,tag in ((+0.6,25,"close (+0.6)"), (-0.6,25,"open  (-0.6)"),
                 (+0.6,25,"close again"),  (-1.5,25,"open harder (-1.5)"),
                 (-1.5,60,"open harder, kp=60")):
    hold(p,kp,2.5,tag)
hold(0.0,10,1.0,"relax")
print(f"\n  total travel seen: {math.degrees(abs(g[0]-base)):.2f} deg-equivalent on group 7")
