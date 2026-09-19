import xml.etree.ElementTree as ET
t = ET.parse("/home/ros/ros2_ws/src/galaxea_a1xy_description/urdf/a1x.urdf")
r = t.getroot()
links = r.findall("link")
withi = [l for l in links if l.find("inertial") is not None]
print(f"links: {len(links)}, with <inertial>: {len(withi)}")
total = 0.0
for l in withi:
    m = float(l.find("inertial/mass").get("value"))
    total += m
    name = l.get("name")
    print(f"  {name:<24} mass={m:.3f} kg")
print(f"total mass: {total:.3f} kg")
