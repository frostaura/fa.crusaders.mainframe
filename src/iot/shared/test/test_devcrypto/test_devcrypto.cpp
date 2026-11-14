// Unity tests for lib/devcrypto — hex.
//
// WHAT THIS SUITE USED TO BE
// --------------------------
// Six hundred lines driving SHA-256, HMAC-SHA256, HKDF and the canonical
// request signer against the shared corpus, with an executed-case ledger
// proving every declared vector had run. All of it went with request signing:
// the box authenticates with one static bearer key now, computes no digests,
// and has nothing secret to compare in constant time. The vectors those tests
// read were deleted from `http/cases.json` in the same change, and the
// corpus's executed-count gate moved to test_bridgelogic, which is the suite
// that still reads it.
//
// WHY WHAT IS LEFT IS STILL WORTH A SUITE
// ---------------------------------------
// Hex leaves this box in two places that a person never sees before they fail:
// the MAC that names the device in every request body — which an auto-
// registering backend keys everything off — and the walk-up purchase nonce that
// makes a retry replay-safe rather than a second charge. Both are compared as
// TEXT on the server, so case and length are load-bearing, and both are
// produced by code that has no other reader to disagree with it.

#include <stdint.h>
#include <string.h>
#include <unity.h>

#include "devcrypto/Hex.h"

void test_hex_encodes_lowercase_and_round_trips(void) {
  const uint8_t bytes[] = {0x00U, 0x0FU, 0xA5U, 0xFFU, 0xDEU, 0xADU};
  char text[dc::hex::encodedSize(sizeof(bytes))];

  // Lowercase is a rule, not a preference: the server compares this text.
  TEST_ASSERT_TRUE(dc::hex::encodeLower(bytes, sizeof(bytes), text, sizeof(text)));
  TEST_ASSERT_EQUAL_STRING("000fa5ffdead", text);

  // One byte short of the terminator must fail rather than truncate. A
  // truncated MAC names a different device, and the box would auto-register a
  // second one rather than fail visibly.
  char tooSmall[dc::hex::encodedSize(sizeof(bytes)) - 1];
  TEST_ASSERT_FALSE(dc::hex::encodeLower(bytes, sizeof(bytes), tooSmall, sizeof(tooSmall)));

  uint8_t decoded[sizeof(bytes)];
  size_t decodedLen = 0;
  TEST_ASSERT_TRUE(dc::hex::decode(text, strlen(text), decoded, sizeof(decoded), &decodedLen));
  TEST_ASSERT_EQUAL_size_t(sizeof(bytes), decodedLen);
  TEST_ASSERT_EQUAL_HEX8_ARRAY(bytes, decoded, sizeof(bytes));

  // Uppercase is accepted on input, an odd length and a non-hex character are not.
  TEST_ASSERT_TRUE(dc::hex::decode("A5FF", 4, decoded, sizeof(decoded), &decodedLen));
  TEST_ASSERT_EQUAL_HEX8(0xA5U, decoded[0]);
  TEST_ASSERT_FALSE(dc::hex::decode("abc", 3, decoded, sizeof(decoded), &decodedLen));
  TEST_ASSERT_FALSE(dc::hex::decode("ab0g", 4, decoded, sizeof(decoded), &decodedLen));
}

void test_hex_encodes_a_mac_at_exactly_the_length_the_contract_names(void) {
  // Six bytes, twelve characters, no separators — the shape `mac` has to be in
  // every request body. WiFi.macAddress() hands over these six bytes and this
  // is the only thing between them and the wire.
  const uint8_t mac[6] = {0x5CU, 0xCFU, 0x7FU, 0x0AU, 0x1BU, 0x2CU};
  char text[dc::hex::encodedSize(sizeof(mac))];
  TEST_ASSERT_EQUAL_size_t(13U, sizeof(text));
  TEST_ASSERT_TRUE(dc::hex::encodeLower(mac, sizeof(mac), text, sizeof(text)));
  TEST_ASSERT_EQUAL_STRING("5ccf7f0a1b2c", text);
  TEST_ASSERT_EQUAL_size_t(12U, strlen(text));
}

void test_hex_an_empty_input_is_an_empty_string_not_a_failure(void) {
  // A zero-length encode is legal and produces a terminator, which is what
  // keeps a caller from reading past an uninitialised buffer on a path that
  // had nothing to say.
  char text[dc::hex::encodedSize(0U)];
  TEST_ASSERT_TRUE(dc::hex::encodeLower(nullptr, 0U, text, sizeof(text)));
  TEST_ASSERT_EQUAL_STRING("", text);

  // But a null with a non-zero length is a caller bug, not an empty value.
  char bigger[8];
  TEST_ASSERT_FALSE(dc::hex::encodeLower(nullptr, 2U, bigger, sizeof(bigger)));
}

void test_hex_decode_refuses_a_buffer_that_would_not_hold_the_result(void) {
  uint8_t tiny[2];
  size_t len = 0;
  TEST_ASSERT_FALSE(dc::hex::decode("00112233", 8, tiny, sizeof(tiny), &len));
  // Exactly enough still works, so the bound is not off by one.
  uint8_t exact[4];
  TEST_ASSERT_TRUE(dc::hex::decode("00112233", 8, exact, sizeof(exact), &len));
  TEST_ASSERT_EQUAL_size_t(4U, len);
}

void setUp(void) {
}

void tearDown(void) {
}

int main(int, char**) {
  UNITY_BEGIN();
  RUN_TEST(test_hex_encodes_lowercase_and_round_trips);
  RUN_TEST(test_hex_encodes_a_mac_at_exactly_the_length_the_contract_names);
  RUN_TEST(test_hex_an_empty_input_is_an_empty_string_not_a_failure);
  RUN_TEST(test_hex_decode_refuses_a_buffer_that_would_not_hold_the_result);
  return UNITY_END();
}
