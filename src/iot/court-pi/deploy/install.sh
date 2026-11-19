#!/usr/bin/env bash
# Crusaders court box on a Raspberry Pi — install / update, run ON THE PI from
# a checkout of this repository:
#
#   sudo src/iot/court-pi/deploy/install.sh
#
# Idempotent: re-running it rebuilds and reinstalls the two programs and leaves
# every setting it already wrote alone. Reboot once after the first run (I2C,
# UART and the config.txt pin states only take effect at boot).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd "$HERE/.." && pwd)"
BOOT_CONFIG=/boot/firmware/config.txt
[ -f "$BOOT_CONFIG" ] || BOOT_CONFIG=/boot/config.txt

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo $0" >&2
  exit 1
fi
if [ ! -f "$PROJECT/config/common/secrets.h" ]; then
  echo "missing $PROJECT/config/common/secrets.h — copy secrets.h.example beside it and fill in all four values" >&2
  exit 1
fi

echo "== packages"
apt-get update -qq
apt-get install -y -qq cmake g++ i2c-tools network-manager >/dev/null

echo "== the court user"
id court >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin court
for g in gpio i2c dialout; do getent group "$g" >/dev/null && usermod -aG "$g" court; done

echo "== build (about two minutes on a Pi 5)"
cmake -S "$PROJECT" -B "$PROJECT/build" -DCMAKE_BUILD_TYPE=RelWithDebInfo >/dev/null
cmake --build "$PROJECT/build" -j"$(nproc)"
(cd "$PROJECT/build" && ctest --output-on-failure)
install -m 0755 "$PROJECT/build/court-io" "$PROJECT/build/court-brain" /usr/local/bin/

echo "== services"
install -m 0644 "$HERE/systemd/court-io.service" "$HERE/systemd/court-brain.service" /etc/systemd/system/
install -d /etc/systemd/system.conf.d
install -m 0644 "$HERE/systemd/court-box-watchdog.conf" /etc/systemd/system.conf.d/
install -d /etc/polkit-1/rules.d
install -m 0644 "$HERE/polkit/50-court-brain-wifi.rules" /etc/polkit-1/rules.d/
install -d -m 0750 /etc/court-box
[ -f /etc/court-box/court-box.env ] || install -m 0640 -g court "$HERE/court-box.env.example" /etc/court-box/court-box.env

echo "== boot configuration"
if ! grep -q 'crusaders court box (court-pi)' "$BOOT_CONFIG"; then
  cat "$HERE/config.txt.court-box" >>"$BOOT_CONFIG"
fi
if command -v raspi-config >/dev/null; then
  raspi-config nonint do_i2c 0         # I2C on
  raspi-config nonint do_serial_cons 1 # no login console on the scanner's UART
  raspi-config nonint do_serial_hw 0   # the UART itself stays on
fi
# Fewer SD-card writes: the journal lives in RAM (court-brain's records are fsynced).
install -d /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=32M\n' >/etc/systemd/journald.conf.d/court-box.conf

systemctl daemon-reload
systemctl enable court-io.service court-brain.service
echo
echo "Installed. Reboot now (sudo reboot) — then: journalctl -u court-io -u court-brain -f"
