#!/usr/bin/env bash
# Measure the leader's state WITHOUT transmitting anything to it.
echo "=== passive check on can1 (nothing transmitted) ==="
timeout -k 1 4 candump can1 </dev/null 2>/dev/null > /tmp/cc.log
n=$(grep -c " 052 " /tmp/cc.log)
d=$(grep " 052 " /tmp/cc.log | awk '{$1=$2=$3=$4=""; print}' | sort -u | wc -l)
echo "  0x052: $n frames, $d distinct payloads"
if [ "$d" -gt 1 ]; then
  echo "  -> ENCODERS REPORTING"
else
  echo "  -> FROZEN (transmitting, but not reporting)"
fi
echo "  ids seen: $(awk '{print $2}' /tmp/cc.log | sort -u | tr '\n' ' ')"
