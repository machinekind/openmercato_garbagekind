import sys
from pathlib import Path

# The bridge is a plain package, not an installed distribution.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
