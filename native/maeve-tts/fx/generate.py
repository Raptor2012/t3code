"""Writes voicefx.f32: the EQ and plate-reverb kernels of the approved "Techno audio effect".

Layout (little-endian float32): [eq_len, ir_len] as floats, then the EQ taps, then the reverb IR.
The reverb IR comes from numpy's seeded generator, so it is precomputed here rather than
regenerated at runtime. Run with the standalone orb's environment:
    python generate.py <path to t3_voice_core.py's folder>
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, sys.argv[1])
from t3_voice_core import VoiceFx, _minimum_phase_eq  # noqa: E402

fx = VoiceFx()
eq = _minimum_phase_eq(24000)
out = np.concatenate([[len(eq), len(fx.ir)], eq, fx.ir]).astype("<f4")
target = Path(__file__).with_name("voicefx.f32")
out.tofile(target)
print(target, len(eq), len(fx.ir))
