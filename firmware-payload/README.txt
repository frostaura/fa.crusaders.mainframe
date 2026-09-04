Firmware payload baked into the API image at /app/firmware/.

If this README is the only file here, NO firmware was baked into this image.
That is the normal state of a local `docker compose build`: the directory exists
in the repository only so the Dockerfile's `COPY firmware-payload/ /app/firmware/`
has something to copy when no CI artifact is present.

In CI the `iot-sign` job (.github/workflows/ci.yml) replaces the contents of this
directory before the backend image is built, with either:

  court_bridge.signed.bin   the ESP8266 image with the RSA-2048/SHA-256 OTA trailer
  firmware.manifest.json    {"version","url","sizeBytes"} — what Ota:Stable falls back to

or, when the OTA_PRIVATE_KEY secret is unset, a README.txt saying the build is
UNSIGNED and cannot be installed over the air (go-live checklist item 6).

Do not commit .bin or manifest files here — the image gets them from CI, and a
committed copy would silently outrank the signed one.
