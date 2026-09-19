"""Do OUR raw 0x050 frames move the arm? Command J1 +2 deg and measure."""
import socket, struct, sys, time, math
IFACE = sys.argv[1] if len(sys.argv)>1 else "can0"
STEP  = math.radians(float(sys.argv[2]) if len(sys.argv)>2 else 2.0)
KP    = float(sys.argv[3]) if len(sys.argv)>3 else 20.0
KD    = float(sys.argv[4]) if len(sys.argv)>4 else 1.0
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
def q():
    end=time.time()+1.0
    while time.time()<end:
        try: b=s.recv(72)
        except socket.timeout: continue
        if (struct.unpack("=I",b[:4])[0]&0x1FFFFFFF)!=0x052: continue
        v=struct.unpack(">21h",b[8:8+42]); return [v[g*3]/4700.0 for g in range(6)]
    return None
def hold(target,secs):
    t0=time.time(); n=0
    while time.time()-t0<secs:
        send(s,0x050,encode(target,[0.0]*6,[KP]*6,[KD]*6,[0.0]*6)); n+=1
        time.sleep(1/200.0)
    return n
start=q()
if not start: print("  no feedback"); raise SystemExit(1)
print(f"  start J1 = {math.degrees(start[0]):+.3f} deg   (kp={KP} kd={KD})")
tgt=list(start); tgt[0]=start[0]+STEP
print(f"  commanding J1 -> {math.degrees(tgt[0]):+.3f} deg  (step {math.degrees(STEP):+.2f})")
n=hold(tgt,2.5); after=q()
print(f"  sent {n} frames; J1 now {math.degrees(after[0]):+.3f} deg")
moved=math.degrees(after[0]-start[0])
print(f"  MOVED {moved:+.3f} deg of {math.degrees(STEP):+.2f} commanded  ->  {moved/math.degrees(STEP)*100:.0f}%")
cross=max(abs(math.degrees(after[i]-start[i])) for i in range(1,6))
print(f"  largest other-joint move: {cross:.2f} deg")
hold(start,2.0); back=q()
print(f"  returned to {math.degrees(back[0]):+.3f} deg (start was {math.degrees(start[0]):+.3f})")
print()
print("  VERDICT: our raw 0x050 frames " + ("DO control this arm" if abs(moved)>0.3 else "ARE BEING IGNORED"))
