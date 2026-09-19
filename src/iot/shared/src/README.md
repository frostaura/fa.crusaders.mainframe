# PlatformIO wants a `src_dir` and this project has no application code: it is
# libraries and their host tests, nothing else. Every environment in
# `platformio.ini` sets `build_src_filter = -<*>`, so nothing here is ever
# compiled — the directory exists only so PlatformIO does not have to guess.
#
# Do not put firmware in here. A composition root belongs to the project that
# owns the board it boots.
