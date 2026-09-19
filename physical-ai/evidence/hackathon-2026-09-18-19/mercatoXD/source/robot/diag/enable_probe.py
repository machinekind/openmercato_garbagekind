"""After each enable code, does can1 accept a 0x050 motion command?"""
import socket, struct, time, math, subprocess
IFACE=__import__("sys").argv[1] if len(__import__("sys").argv)>1 else "can1"; KP=20.0; KD=1.0
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
def drain(t=0.5):
    end=time.time()+t; got=None
    while time.time()<end:
        try: b=s.recv(72)
        except (BlockingIOError,socket.timeout):
            if got: return got
            time.sleep(0.001); continue
        if (struct.unpack("=I",b[:4])[0]&0x1FFFFFFF)!=0x052: continue
        v=struct.unpack(">21h",b[8:8+42])
        got=([v[g*3]/4700.0 for g in range(7)],[v[g*3+2]/600.0 for g in range(7)])
    return got
def trial(label):
    st=drain(1.0)
    if not st: return print(f"  {label:<22} no feedback")
    q0,e0=st; tgt=list(q0[:6]); tgt[0]=q0[0]+math.radians(2.0)
    peak=0.0; t0=time.time()
    while time.time()-t0<2.0:
        s.send(struct.pack("=IBBBB",0x050,60,0x01,0,0)+encode(tgt,[0.0]*6,[KP]*6,[KD]*6,[0.0]*6).ljust(64,b"\x00"))
        g=drain(0.005)
        if g: peak=max(peak,abs(g[0][0]-q0[0]))
        time.sleep(1/200.0)
    e=drain(0.5)
    print(f"  {label:<22} moved {math.degrees(peak):5.2f} deg of 2.00   "
          f"eff {max(abs(x) for x in e[1][:6]):5.2f}   {'OBEYS' if math.degrees(peak)>0.3 else 'ignores'}")
trial("baseline (no code)")
for c in (1,5,6):
    subprocess.run(f"cansend {IFACE} 053#{c:02X}", shell=True, check=True)
    time.sleep(1.0)
    trial(f"after FF {c}")
