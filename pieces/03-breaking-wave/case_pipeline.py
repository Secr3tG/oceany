"""case_pipeline: the pipeline breaking-wave case (illustrative 2D slice, not a forecast).

Its settings are in spot_case.py (SPOT_CASES) and ../../spots.json; the code is slice_case.py, shared with Porto Batel.
This file only gives the case a module name, so tools can `import case_pipeline`.
"""
from spot_case import case_names

globals().update(case_names("pipeline"))   # CFG, profile, bed_z, build, piston_motion_factory, ...
