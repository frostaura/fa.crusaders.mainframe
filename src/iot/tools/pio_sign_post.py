"""PlatformIO post-build hook: sign the court-box firmware when a key is present.

Wired from platformio.ini as `extra_scripts = post:tools/pio_sign_post.py` on the
court_bridge environment. After a successful build it looks for the OTA private
key at $OTA_PRIVATE_KEY and, if it is there, produces firmware.signed.bin next to
firmware.bin using tools/sign_firmware.py.

The key is DELIBERATELY optional. Local and CI builds without it still produce the
plain firmware.bin, which is what you flash over USB — and USB flashing does not
check signatures, so an unsigned dev build works. Only OTA needs the signature,
and only the release pipeline (which sets $OTA_PRIVATE_KEY from a secret) cuts an
image OTA will accept. A missing key is a loud skip, never a silent one: a release
job that forgot to set the secret should see "NOT SIGNED" in its log, not discover
it when every board rejects the update.
"""

import os
import sys

Import("env")  # noqa: F821 — provided by PlatformIO's SConscript context

# __file__ is not defined in PlatformIO's SConscript exec context, so locate the
# tools directory from the project dir the env exposes.
_TOOLS = os.path.join(env.subst("$PROJECT_DIR"), "tools")  # noqa: F821
sys.path.insert(0, _TOOLS)
import sign_firmware  # noqa: E402


def _sign(source, target, env):  # noqa: ARG001 — SCons signature
    key_path = os.environ.get("OTA_PRIVATE_KEY", "").strip()
    build_dir = env.subst("$BUILD_DIR")
    firmware = os.path.join(build_dir, "firmware.bin")

    if not key_path:
        print("[ota-sign] OTA_PRIVATE_KEY not set — firmware.bin is NOT SIGNED "
              "(fine for USB; OTA will refuse it)")
        return
    if not os.path.isfile(key_path):
        # A set-but-wrong path is an operator error worth failing on: the release
        # meant to sign and did not.
        raise SystemExit(f"[ota-sign] OTA_PRIVATE_KEY points at no file: {key_path}")
    if not os.path.isfile(firmware):
        print(f"[ota-sign] no firmware at {firmware}; nothing to sign")
        return

    with open(firmware, "rb") as f:
        image = f.read()
    signed = sign_firmware.sign_image(image, key_path)
    out = os.path.join(build_dir, "firmware.signed.bin")
    with open(out, "wb") as f:
        f.write(signed)
    print(f"[ota-sign] wrote {out} (+{len(signed) - len(image)} bytes of signature trailer)")


env.AddPostAction("$BUILD_DIR/firmware.bin", _sign)  # noqa: F821
