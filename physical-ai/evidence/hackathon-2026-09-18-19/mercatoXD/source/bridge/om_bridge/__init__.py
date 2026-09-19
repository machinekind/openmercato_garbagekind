"""Open Mercato <-> A1X arm bridge.

The Open Mercato `robotics` module queues pick tasks ("grab the can"); this
process claims them, drives the arm through the web panel, and reports every
transition back. It is the only piece that touches both worlds, so the
integration surface stays one HTTP contract wide.
"""

__version__ = "0.1.0"
