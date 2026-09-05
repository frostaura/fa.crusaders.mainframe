// Unity tests for the over-the-air update decision and the guard that stops a
// bad build being taken twice.
//
// WHY THIS SUITE EXISTS AND WHAT IT DELIBERATELY DOES NOT COVER
// ------------------------------------------------------------
// The install itself is platform code: the ESP8266 core's Updater with a BearSSL
// public key checking the image signature. It cannot run on the host and it is
// not where the expensive mistakes live.
//
// The expensive mistakes are all decisions. Taking a downgrade. Taking a build
// already known to break. Discovering mid-download that the image will not fit.
// And the one that takes out a whole club at once: reflashing the same broken
// firmware in a loop, on every board, because they all heartbeat against the
// same manifest.
//
// Those are what is tested here, at every clock base the rest of the firmware
// uses, because a court box is expected to run for months.

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unity.h>

#include "fakes/FakeStore.h"
#include "otacore/BootGuard.h"
#include "otacore/UpdatePolicy.h"
#include "otacore/Version.h"

namespace {

ota::Manifest manifest(const char* version, const char* url = "http://10.0.0.5/fw.bin",
                       uint32_t size = 300000U) {
  ota::Manifest m;
  m.present = true;
  snprintf(m.version, sizeof(m.version), "%s", version);
  snprintf(m.url, sizeof(m.url), "%s", url);
  m.sizeBytes = size;
  return m;
}

// --- versions --------------------------------------------------------------

void test_version_parses_a_three_part_number() {
  const ota::Version v = ota::parseVersion("1.2.3");
  TEST_ASSERT_TRUE(v.parsed);
  TEST_ASSERT_EQUAL_UINT16(1U, v.major);
  TEST_ASSERT_EQUAL_UINT16(2U, v.minor);
  TEST_ASSERT_EQUAL_UINT16(3U, v.patch);
}

void test_version_ten_is_newer_than_nine() {
  // The reason this is not strcmp. As text "1.10.0" sorts BEFORE "1.9.0", so a
  // box comparing strings stops taking updates the moment a minor number reaches
  // double digits — and does it silently, deciding it already has the newer one.
  TEST_ASSERT_TRUE(ota::parseVersion("1.9.0").olderThan(ota::parseVersion("1.10.0")));
  TEST_ASSERT_FALSE(ota::parseVersion("1.10.0").olderThan(ota::parseVersion("1.9.0")));

  TEST_ASSERT_TRUE(ota::parseVersion("1.2.9").olderThan(ota::parseVersion("1.2.10")));
  TEST_ASSERT_TRUE(ota::parseVersion("9.0.0").olderThan(ota::parseVersion("10.0.0")));
}

void test_version_equal_is_not_older() {
  TEST_ASSERT_FALSE(ota::parseVersion("2.0.0").olderThan(ota::parseVersion("2.0.0")));
}

void test_version_refuses_a_suffix_rather_than_ignoring_it() {
  // "1.2.3-rc1" must not compare equal to "1.2.3", or a release candidate blocks
  // the release it is a candidate for.
  TEST_ASSERT_FALSE(ota::parseVersion("1.2.3-rc1").parsed);
  TEST_ASSERT_FALSE(ota::parseVersion("1.2").parsed);
  TEST_ASSERT_FALSE(ota::parseVersion("v1.2.3").parsed);
  TEST_ASSERT_FALSE(ota::parseVersion("").parsed);
  TEST_ASSERT_FALSE(ota::parseVersion(nullptr).parsed);
  TEST_ASSERT_FALSE(ota::parseVersion("1.2.99999").parsed);
}

void test_version_an_unparseable_running_version_can_still_escape() {
  // A box running a broken version string is the box most in need of an update.
  // Treating "unknown" as newest would strand exactly those.
  TEST_ASSERT_TRUE(ota::parseVersion("garbage").olderThan(ota::parseVersion("1.0.0")));
  TEST_ASSERT_FALSE(ota::parseVersion("garbage").olderThan(ota::parseVersion("also-garbage")));
}

// --- the decision ----------------------------------------------------------

void test_policy_installs_a_newer_build() {
  fakes::FakeStore store;
  ota::BootGuard guard(&store);
  static_cast<void>(guard.begin());

  TEST_ASSERT_TRUE(ota::decide(manifest("1.1.0"), "1.0.0", guard, 500000U) == ota::Decision::Install);
}

void test_policy_refuses_a_downgrade_and_a_repeat() {
  fakes::FakeStore store;
  ota::BootGuard guard(&store);
  static_cast<void>(guard.begin());

  // A manifest rolled back on the server must not make every box flap between
  // two versions, reflashing on each heartbeat.
  TEST_ASSERT_TRUE(ota::decide(manifest("0.9.0"), "1.0.0", guard, 500000U) == ota::Decision::NotNewer);
  TEST_ASSERT_TRUE(ota::decide(manifest("1.0.0"), "1.0.0", guard, 500000U) == ota::Decision::NotNewer);
}

void test_policy_refuses_an_image_that_will_not_fit_before_downloading_it() {
  fakes::FakeStore store;
  ota::BootGuard guard(&store);
  static_cast<void>(guard.begin());

  // Discovering this halfway through leaves a half-written sketch on a board in
  // a locked cupboard.
  TEST_ASSERT_TRUE(ota::decide(manifest("2.0.0", "http://x/f.bin", 900000U), "1.0.0", guard, 500000U) ==
                   ota::Decision::WillNotFit);
}

void test_policy_refuses_an_incomplete_manifest() {
  fakes::FakeStore store;
  ota::BootGuard guard(&store);
  static_cast<void>(guard.begin());

  TEST_ASSERT_TRUE(ota::decide(manifest("2.0.0", "", 300000U), "1.0.0", guard, 0U) ==
                   ota::Decision::Unusable);
  TEST_ASSERT_TRUE(ota::decide(manifest("", "http://x/f.bin", 300000U), "1.0.0", guard, 0U) ==
                   ota::Decision::Unusable);
  TEST_ASSERT_TRUE(ota::decide(manifest("2.0.0", "http://x/f.bin", 0U), "1.0.0", guard, 0U) ==
                   ota::Decision::Unusable);
  TEST_ASSERT_TRUE(ota::decide(manifest("not-a-version"), "1.0.0", guard, 0U) == ota::Decision::Unusable);

  ota::Manifest none;
  TEST_ASSERT_TRUE(ota::decide(none, "1.0.0", guard, 0U) == ota::Decision::NothingOffered);
}

void test_policy_every_refusal_has_a_reason_worth_showing() {
  const ota::Decision all[] = {ota::Decision::Install,    ota::Decision::NothingOffered,
                               ota::Decision::NotNewer,   ota::Decision::KnownBad,
                               ota::Decision::WillNotFit, ota::Decision::Unusable,
                               ota::Decision::Deferred,   ota::Decision::InstallFailed};
  for (size_t i = 0U; i < sizeof(all) / sizeof(all[0]); ++i) {
    const char* text = ota::describe(all[i]);
    TEST_ASSERT_NOT_NULL(text);
    TEST_ASSERT_TRUE(strlen(text) > 0U);
    TEST_ASSERT_TRUE(strcmp(text, "unknown") != 0);
  }
}

void test_policy_defers_while_a_court_is_in_use_and_installs_on_the_next_quiet_beat() {
  // REVIEW 3, FINDING 8. `considerUpdate` ran on every accepted heartbeat and
  // `decide` looked only at the manifest, the version, the guard and free
  // space. So an API deployed at 19:05 with a newer baked image had every box
  // in the club painting UPDATING, blocking on a ~400 KB download and rebooting
  // with courts lit — and the reboot loses the per-court booking ends `!EXT`
  // needs, so a 20:30 booking darkens at 20:00 mid-game.
  fakes::FakeStore store;
  ota::BootGuard guard(&store);
  static_cast<void>(guard.begin());

  ota::InstallGate busy;
  busy.courtsBusy = true;
  TEST_ASSERT_TRUE(ota::decide(manifest("1.1.0"), "1.0.0", guard, 0U, busy) == ota::Decision::Deferred);

  // Nothing else about the offer changed — it installs the moment the box is
  // idle, which is what makes this a deferral rather than a refusal.
  ota::InstallGate idle;
  TEST_ASSERT_TRUE(ota::decide(manifest("1.1.0"), "1.0.0", guard, 0U, idle) == ota::Decision::Install);
  TEST_ASSERT_TRUE(ota::decide(manifest("1.1.0"), "1.0.0", guard, 0U) == ota::Decision::Install);

  // A busy box still refuses a downgrade for the RIGHT reason: the deferral is
  // last, so the admin screen never blames the courts for a bad manifest.
  TEST_ASSERT_TRUE(ota::decide(manifest("0.9.0"), "1.0.0", guard, 0U, busy) == ota::Decision::NotNewer);
  TEST_ASSERT_TRUE(ota::decide(manifest("1.1.0"), "1.0.0", guard, 10U, busy) == ota::Decision::WillNotFit);
}

void test_policy_stops_reflashing_an_image_that_keeps_failing() {
  // REVIEW 3, FINDING 5, BOX SIDE. `iot-sign` signs with whatever
  // OTA_PRIVATE_KEY holds and nothing checks it against the committed public
  // key. A mismatch ships a CI-green release every box rejects — after the full
  // download — and `decide` had no memory of it, so the API re-offered on every
  // heartbeat and the fleet painted UPDATING / UPDATE FAILED over every session
  // for as long as the release stood.
  fakes::FakeStore store;
  ota::BootGuard guard(&store);
  static_cast<void>(guard.begin());

  ota::InstallMemo memo;
  ota::InstallGate gate;
  gate.memo = &memo;
  const ota::Manifest bad = manifest("1.1.0");

  // A transient — an interrupted download on a flapping link — deserves
  // another go, so the first failures do not skip it.
  for (uint8_t i = 1U; i < ota::kInstallAttempts; ++i) {
    memo.failed(bad);
    TEST_ASSERT_TRUE(ota::decide(bad, "1.0.0", guard, 0U, gate) == ota::Decision::Install);
    TEST_ASSERT_EQUAL_STRING("", memo.skippedVersion());
  }
  memo.failed(bad);
  TEST_ASSERT_TRUE(ota::decide(bad, "1.0.0", guard, 0U, gate) == ota::Decision::InstallFailed);
  TEST_ASSERT_EQUAL_STRING("1.1.0", memo.skippedVersion());

  // Re-signing and re-uploading is the operator's repair, and it must clear the
  // memory. The version can even stay the same: the URL or the size moves.
  const ota::Manifest resigned = manifest("1.1.0", "http://10.0.0.5/fw.bin", 300512U);
  TEST_ASSERT_FALSE(memo.exhausted(resigned));
  TEST_ASSERT_TRUE(ota::decide(resigned, "1.0.0", guard, 0U, gate) == ota::Decision::Install);

  // A different release is a different offer, and gets its own attempts.
  const ota::Manifest next = manifest("1.2.0");
  TEST_ASSERT_FALSE(memo.exhausted(next));
  TEST_ASSERT_TRUE(ota::decide(next, "1.0.0", guard, 0U, gate) == ota::Decision::Install);

  // A box that keeps no memo behaves exactly as before.
  ota::InstallGate none;
  TEST_ASSERT_TRUE(ota::decide(bad, "1.0.0", guard, 0U, none) == ota::Decision::Install);
}

// --- the boot guard --------------------------------------------------------

void test_guard_an_ordinary_boot_is_settled() {
  fakes::FakeStore store;
  ota::BootGuard guard(&store);
  TEST_ASSERT_TRUE(guard.begin() == ota::BootState::Settled);
  TEST_ASSERT_EQUAL_UINT8(0U, guard.attempts());
}

void test_guard_an_update_is_proving_until_the_api_accepts_something() {
  fakes::FakeStore store;
  {
    ota::BootGuard installer(&store);
    static_cast<void>(installer.begin());
    installer.arm("1.1.0");
  }

  // First boot of the new image.
  ota::BootGuard guard(&store);
  TEST_ASSERT_TRUE(guard.begin() == ota::BootState::Proving);
  TEST_ASSERT_EQUAL_UINT8(1U, guard.attempts());

  // "Booted" is not "working". A firmware that comes up and cannot authenticate
  // looks alive and does nothing, which is worse than one that does not come up.
  guard.confirm();
  TEST_ASSERT_TRUE(guard.state() == ota::BootState::Settled);

  // ...and the next boot is an ordinary one.
  ota::BootGuard later(&store);
  TEST_ASSERT_TRUE(later.begin() == ota::BootState::Settled);
}

void test_guard_condemns_a_build_that_never_proves_itself() {
  fakes::FakeStore store;
  {
    ota::BootGuard installer(&store);
    static_cast<void>(installer.begin());
    installer.arm("1.1.0");
  }

  // Boot, boot, boot — never once an accepted call.
  ota::BootState last = ota::BootState::Settled;
  for (uint8_t i = 0U; i < ota::kMaxAttempts; ++i) {
    ota::BootGuard guard(&store);
    last = guard.begin();
  }
  TEST_ASSERT_TRUE(last == ota::BootState::Failed);

  ota::BootGuard after(&store);
  static_cast<void>(after.begin());
  TEST_ASSERT_TRUE(after.isKnownBad("1.1.0"));
  TEST_ASSERT_EQUAL_STRING("1.1.0", after.badVersion());

  // The refusal that stops a whole club reflashing in a loop: every box is
  // offered the same manifest, so without this they would all do it at once.
  TEST_ASSERT_TRUE(ota::decide(manifest("1.1.0"), "1.0.0", after, 500000U) == ota::Decision::KnownBad);
}

void test_guard_tolerates_a_reboot_that_is_not_the_firmwares_fault() {
  fakes::FakeStore store;
  {
    ota::BootGuard installer(&store);
    static_cast<void>(installer.begin());
    installer.arm("1.1.0");
  }

  // Four relay coils energising at once brown the rail out and the box resets.
  // Condemning a good build for somebody else's power supply would be worse than
  // the problem, so one reboot is not a verdict.
  ota::BootGuard first(&store);
  TEST_ASSERT_TRUE(first.begin() == ota::BootState::Proving);

  ota::BootGuard second(&store);
  TEST_ASSERT_TRUE(second.begin() == ota::BootState::Proving);
  second.confirm();

  ota::BootGuard third(&store);
  TEST_ASSERT_TRUE(third.begin() == ota::BootState::Settled);
  TEST_ASSERT_FALSE(third.isKnownBad("1.1.0"));
}

void test_guard_condemning_one_build_does_not_block_the_fix() {
  fakes::FakeStore store;
  {
    ota::BootGuard installer(&store);
    static_cast<void>(installer.begin());
    installer.arm("1.1.0");
  }
  for (uint8_t i = 0U; i < ota::kMaxAttempts; ++i) {
    ota::BootGuard guard(&store);
    static_cast<void>(guard.begin());
  }

  ota::BootGuard guard(&store);
  static_cast<void>(guard.begin());

  // A bare counter would block the next update too — including the one that
  // fixes it. Recording WHICH build failed is what makes the real incident
  // sequence work: 1.1.0 is refused, 1.1.1 is taken.
  TEST_ASSERT_TRUE(ota::decide(manifest("1.1.0"), "1.0.0", guard, 500000U) == ota::Decision::KnownBad);
  TEST_ASSERT_TRUE(ota::decide(manifest("1.1.1"), "1.0.0", guard, 500000U) == ota::Decision::Install);
}

void test_guard_survives_a_store_that_cannot_be_written() {
  fakes::FakeStore store;
  store.setWriteFailure(true);

  ota::BootGuard guard(&store);
  // A box whose flash has worn out must still boot and still work. It loses the
  // ability to condemn a bad build, which is a degraded guard rather than a dead
  // court.
  TEST_ASSERT_TRUE(guard.begin() == ota::BootState::Settled);
  guard.arm("1.1.0");
  TEST_ASSERT_TRUE(guard.begin() == ota::BootState::Settled);
}

void test_guard_ignores_a_marker_too_damaged_to_read() {
  fakes::FakeStore store;
  const uint8_t junk[] = {0x01U, 0x02U};
  static_cast<void>(store.put(ota::kKeyPending, junk, sizeof(junk)));

  // A torn write leaves a record that is neither absent nor whole. Treated as
  // absent: acting on a half-written marker could condemn a build nobody
  // installed.
  ota::BootGuard guard(&store);
  TEST_ASSERT_TRUE(guard.begin() == ota::BootState::Settled);
}

void test_guard_works_with_no_store() {
  ota::BootGuard guard(nullptr);
  TEST_ASSERT_TRUE(guard.begin() == ota::BootState::Settled);
  guard.arm("1.1.0");
  guard.confirm();
  TEST_ASSERT_FALSE(guard.isKnownBad("1.1.0"));
}

// --- the manifest on the wire ----------------------------------------------

void test_manifest_reads_an_offer_out_of_a_heartbeat() {
  const char body[] =
      "{\"server_unix\":1750000000,\"config\":{\"slice_minutes\":15},"
      "\"ota\":{\"ota_version\":\"1.2.0\",\"ota_url\":\"http://10.0.0.5/fw.bin\",\"ota_size\":328192}}";

  const ota::Manifest m = ota::parseManifest(body, sizeof(body) - 1U);
  TEST_ASSERT_TRUE(m.present);
  TEST_ASSERT_EQUAL_STRING("1.2.0", m.version);
  TEST_ASSERT_EQUAL_STRING("http://10.0.0.5/fw.bin", m.url);
  TEST_ASSERT_EQUAL_UINT32(328192U, m.sizeBytes);
}

void test_manifest_absent_is_the_ordinary_case_not_an_error() {
  const char body[] = "{\"server_unix\":1750000000,\"config\":{\"slice_minutes\":15}}";
  const ota::Manifest m = ota::parseManifest(body, sizeof(body) - 1U);
  TEST_ASSERT_FALSE(m.present);

  fakes::FakeStore store;
  ota::BootGuard guard(&store);
  static_cast<void>(guard.begin());
  TEST_ASSERT_TRUE(ota::decide(m, "1.0.0", guard, 500000U) == ota::Decision::NothingOffered);
}

void test_manifest_an_absurd_size_is_refused_rather_than_wrapped() {
  const char body[] = "{\"ota\":{\"ota_version\":\"1.2.0\",\"ota_url\":\"http://x/"
                      "f.bin\",\"ota_size\":99999999999999999999}}";
  const ota::Manifest m = ota::parseManifest(body, sizeof(body) - 1U);
  // Saturating to zero rather than wrapping into a plausible small size, which
  // would pass the fit check and then run out of flash mid-write.
  TEST_ASSERT_EQUAL_UINT32(0U, m.sizeBytes);

  fakes::FakeStore store;
  ota::BootGuard guard(&store);
  static_cast<void>(guard.begin());
  TEST_ASSERT_TRUE(ota::decide(m, "1.0.0", guard, 500000U) == ota::Decision::Unusable);
}

} // namespace

void setUp() {
}

void tearDown() {
}

int main(int, char**) {
  UNITY_BEGIN();

  RUN_TEST(test_version_parses_a_three_part_number);
  RUN_TEST(test_version_ten_is_newer_than_nine);
  RUN_TEST(test_version_equal_is_not_older);
  RUN_TEST(test_version_refuses_a_suffix_rather_than_ignoring_it);
  RUN_TEST(test_version_an_unparseable_running_version_can_still_escape);

  RUN_TEST(test_policy_installs_a_newer_build);
  RUN_TEST(test_policy_refuses_a_downgrade_and_a_repeat);
  RUN_TEST(test_policy_refuses_an_image_that_will_not_fit_before_downloading_it);
  RUN_TEST(test_policy_refuses_an_incomplete_manifest);
  RUN_TEST(test_policy_every_refusal_has_a_reason_worth_showing);
  RUN_TEST(test_policy_defers_while_a_court_is_in_use_and_installs_on_the_next_quiet_beat);
  RUN_TEST(test_policy_stops_reflashing_an_image_that_keeps_failing);

  RUN_TEST(test_guard_an_ordinary_boot_is_settled);
  RUN_TEST(test_guard_an_update_is_proving_until_the_api_accepts_something);
  RUN_TEST(test_guard_condemns_a_build_that_never_proves_itself);
  RUN_TEST(test_guard_tolerates_a_reboot_that_is_not_the_firmwares_fault);
  RUN_TEST(test_guard_condemning_one_build_does_not_block_the_fix);
  RUN_TEST(test_guard_survives_a_store_that_cannot_be_written);
  RUN_TEST(test_guard_ignores_a_marker_too_damaged_to_read);
  RUN_TEST(test_guard_works_with_no_store);

  RUN_TEST(test_manifest_reads_an_offer_out_of_a_heartbeat);
  RUN_TEST(test_manifest_absent_is_the_ordinary_case_not_an_error);
  RUN_TEST(test_manifest_an_absurd_size_is_refused_rather_than_wrapped);

  return UNITY_END();
}
