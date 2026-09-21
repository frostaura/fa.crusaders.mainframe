// Unity tests for lib/devapi's heapless JSON scanner — specifically, what it
// treats as a KEY.
//
// WHY THIS SUITE EXISTS AT ALL
// ----------------------------
// The scanner had one sharp edge and it was found by a one-field probe rather
// than by the corpus: `findKey` looked for the quoted text ANYWHERE in the body
// and returned the first hit, so a quoted string that was a VALUE counted as a
// key. A gate heartbeat response opens `{"kind":"gate",…}` and carries a
// `"gate":{…}` object later, so the first `"gate"` in every single response was
// the value of `kind`. Reading from there passed every contract vector then in
// the gate family,
// because the only `unlock_seconds` in those documents is the right one — and
// would have driven a lock for somebody else's number the moment a field was
// added between the two.
//
// The gate worked around it locally. This suite is the shared fix's own gate,
// and it lives HERE rather than in a firmware project because the scanner is
// compiled into every one of them: a defect in it is as wide as the tree gets.
//
// WHAT A KEY IS, AS PINNED BELOW
// ------------------------------
//   * a quoted string followed by optional whitespace and a colon;
//   * at ANY depth — the court box reads `button_map` out of the heartbeat's
//     nested `config` object with no path expression, and that flat scan is
//     depended upon, not tolerated;
//   * with `\`-escapes honoured when deciding where a string ENDS, so a quote
//     inside a value cannot put the scanner out of phase.
//
// THE DECOYS ARE REAL, NOT SYNTHETIC. `tenant_slug`, `device_code`, `gate_key`
// and `reason` are all strings the SERVER chooses, and three of them are typed
// by an admin. A club that slugs itself `roster`, or names a door
// `heartbeat_seconds`, is a club whose boxes stop working — silently, because
// every one of these failures reads as "the key was absent" and every caller
// treats absence as "learned nothing".
//
// No corpus and no test support: a shared library's suite that needed one
// firmware's fixtures would not be shared.

#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <unity.h>

#include "devapi/Json.h"

namespace {

size_t len(const char* s) {
  return strlen(s);
}

/// The byte a position-returning function landed on, for asserting that
/// `findKey` stopped past the KEY rather than past a look-alike.
char at(const char* body, size_t pos) {
  return pos == devapi::json::kNotFound ? '\0' : body[pos];
}

// ---------------------------------------------------------------------------
// findKey — a key is a quoted string followed by a colon
// ---------------------------------------------------------------------------

/// The gate heartbeat, verbatim from the contract corpus. `"gate"` appears
/// twice: once as the VALUE of `kind` and once as the key of the object that
/// carries `unlock_seconds`.
void test_find_key_skips_a_quoted_string_that_is_a_value() {
  const char* body = "{\"kind\":\"gate\",\"gate\":{\"unlock_seconds\":3}}";
  const size_t pos = devapi::json::findKey(body, len(body), "gate");

  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound, pos);
  // Past the KEY's closing quote, so the next thing is its colon and then the
  // object. Past the VALUE's closing quote the next byte is a comma.
  TEST_ASSERT_EQUAL_CHAR(':', at(body, pos));
  TEST_ASSERT_EQUAL_CHAR('{', at(body, pos + 1U));
}

/// An array element is a quoted string with no colon after it. The court box's
/// `button_map` is eight of them, and an admin types every one.
void test_find_key_skips_a_quoted_string_that_is_an_array_element() {
  const char* body = "{\"button_map\":[\"court:A\",\"heartbeat_seconds\"],\"heartbeat_seconds\":45}";
  const size_t pos = devapi::json::findKey(body, len(body), "heartbeat_seconds");

  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound, pos);
  TEST_ASSERT_EQUAL_CHAR(':', at(body, pos));
  TEST_ASSERT_EQUAL_CHAR('4', at(body, pos + 1U));
}

/// `"court:A"` is an element whose CONTENT holds a colon. A scanner that looked
/// for `"…":` without knowing where strings begin and end would read the
/// element as a key.
void test_find_key_does_not_read_a_colon_inside_a_string_as_a_keys_colon() {
  const char* body = "{\"button_map\":[\"court:A\"]}";

  TEST_ASSERT_EQUAL(devapi::json::kNotFound, devapi::json::findKey(body, len(body), "court"));
}

/// FLAT SCAN, PRESERVED. `button_map`, `slice_minutes` and `walk_up_max_minutes`
/// all live inside the heartbeat's nested `config` object and the court box
/// reads them with no path expression at all. Narrowing findKey to the top
/// level is a breaking change, not a tightening.
void test_find_key_finds_a_nested_key_by_flat_scan() {
  const char* body = "{\"court_numbers\":[1,2],\"heartbeat_seconds\":60,"
                     "\"config\":{\"slice_minutes\":15,\"walk_up_max_minutes\":90,"
                     "\"button_map\":[\"court:A\"]},\"roster\":[]}";

  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound, devapi::json::findKey(body, len(body), "slice_minutes"));
  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound,
                        devapi::json::findKey(body, len(body), "walk_up_max_minutes"));

  uint32_t slice = 0U;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(body, len(body), "slice_minutes", slice));
  TEST_ASSERT_EQUAL_UINT32(15U, slice);

  uint32_t walkUp = 0U;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(body, len(body), "walk_up_max_minutes", walkUp));
  TEST_ASSERT_EQUAL_UINT32(90U, walkUp);

  char token[16] = {};
  size_t element = devapi::json::findArray(body, len(body), "button_map");
  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound, element);
  TEST_ASSERT_TRUE(devapi::json::nextStringElement(body, len(body), element, token, sizeof(token)));
  TEST_ASSERT_EQUAL_STRING("court:A", token);
}

/// JSON allows whitespace between a key and its colon. Nothing the API serves
/// today is pretty-printed, and a scanner that assumed so would be a scanner
/// that breaks on the first proxy that reformats a body.
void test_find_key_allows_whitespace_between_the_key_and_its_colon() {
  const char* body = "{\n  \"kind\" : \"gate\",\n  \"gate\" : { \"unlock_seconds\" : 7 }\n}";

  uint32_t seconds = 0U;
  const size_t pos = devapi::json::findKey(body, len(body), "gate");
  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound, pos);
  TEST_ASSERT_TRUE(devapi::json::unsignedField(body + pos, len(body) - pos, "unlock_seconds", seconds));
  TEST_ASSERT_EQUAL_UINT32(7U, seconds);
}

/// A `\"` inside a value does NOT end the value. A scanner that skipped string
/// values without honouring escapes would think this value ended early, fall
/// out of phase with the document, and miss every key after it — which is worse
/// than the bug it replaced, because it fails on a body the old one read fine.
///
/// These two are REGRESSION GUARDS, not red-before-green tests: the byte-scan
/// implementation this replaced happened to get both right, because a properly
/// escaped inner quote always leaves a backslash adjacent to the text and so
/// can never form the `"key"` byte sequence findKey used to look for. They are
/// proven by mutation instead, and the FIXTURES ARE LOAD-BEARING in a way that
/// is easy to get wrong: an even number of escaped quotes lets a
/// no-escape-handling scanner resynchronise and pass by luck. ONE escaped
/// quote is what puts it permanently out of phase.
void test_find_key_is_not_fooled_by_an_escaped_quote_inside_a_value() {
  //  ...:"he said "hi",...   — exactly one escaped quote, deliberately odd.
  const char* body = "{\"reason\":\"he said \\\"hi\",\"unlock_seconds\":3}";

  uint32_t seconds = 0U;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(body, len(body), "unlock_seconds", seconds));
  TEST_ASSERT_EQUAL_UINT32(3U, seconds);
}

/// An escaped BACKSLASH at the end of a value is the other half of the same
/// trap, and it catches a DIFFERENT mutant: a scanner that skips two bytes only
/// on `\"` walks straight past this value's real terminator, because the quote
/// here is preceded by a backslash that is itself escaped. `\\` is one escaped
/// backslash and the quote after it ends the string.
void test_find_key_is_not_fooled_by_an_escaped_backslash_ending_a_value() {
  const char* body = "{\"reason\":\"ends with a backslash \\\\\",\"unlock_seconds\":4}";

  uint32_t seconds = 0U;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(body, len(body), "unlock_seconds", seconds));
  TEST_ASSERT_EQUAL_UINT32(4U, seconds);
}

/// A truncated body ends the scan rather than being read past. The buffer holds
/// whatever was there before; a scanner that ran on would compare against it.
void test_find_key_reports_an_unterminated_string_rather_than_scanning_past_it() {
  const char* body = "{\"reason\":\"truncated mid-val";

  TEST_ASSERT_EQUAL(devapi::json::kNotFound, devapi::json::findKey(body, len(body), "unlock_seconds"));
}

/// The key itself may be the last thing in the buffer, with no colon after it.
/// That is a truncated body, not a key.
void test_find_key_needs_the_colon_to_be_present() {
  const char* body = "{\"unlock_seconds\"";

  TEST_ASSERT_EQUAL(devapi::json::kNotFound, devapi::json::findKey(body, len(body), "unlock_seconds"));
}

// ---------------------------------------------------------------------------
// The real decoys — server-controlled strings that can equal a key name
// ---------------------------------------------------------------------------

/// `tenant_slug` is the club's own slug and it is sent BEFORE
/// `heartbeat_seconds` on every court-box heartbeat. A club slugged
/// `heartbeat_seconds` would leave every box on its compiled-in cadence,
/// forever, with nothing anywhere saying why.
void test_a_tenant_slug_that_names_a_key_does_not_hide_the_heartbeat_interval() {
  const char* body = "{\"server_time\":\"2023-11-14T22:13:20+00:00\",\"tenant_slug\":\"heartbeat_seconds\","
                     "\"device_code\":\"court-box-1\",\"heartbeat_seconds\":60,\"roster\":[]}";

  uint32_t seconds = 0U;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(body, len(body), "heartbeat_seconds", seconds));
  TEST_ASSERT_EQUAL_UINT32(60U, seconds);
}

/// The same slug against the roster push. This is the worst of the set: the
/// roster is how a box decides anything at all while the link is down, and
/// `findArray` reporting kNotFound means "no roster key" — which the firmware
/// correctly reads as "leave the cache alone", so the box would serve a roster
/// that ages out and then admits nobody.
void test_a_tenant_slug_that_names_a_key_does_not_hide_the_roster() {
  const char* body = "{\"tenant_slug\":\"roster\",\"device_code\":\"court-box-1\","
                     "\"roster\":[\"7Q3F9KM2XZ8B|2|-120|2580\"]}";

  char element[32] = {};
  size_t pos = devapi::json::findArray(body, len(body), "roster");
  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound, pos);
  TEST_ASSERT_TRUE(devapi::json::nextStringElement(body, len(body), pos, element, sizeof(element)));
  TEST_ASSERT_EQUAL_STRING("7Q3F9KM2XZ8B|2|-120|2580", element);
}

/// `device_code` is server-minted and is sent BEFORE `gate_key` on every gate
/// heartbeat. `gate_key` is the door's name in the admin console.
void test_a_device_code_that_names_a_key_does_not_hide_the_gate_key() {
  const char* body = "{\"device_code\":\"gate_key\",\"kind\":\"gate\",\"gate_key\":\"front-door\","
                     "\"heartbeat_seconds\":60}";

  char gateKey[32] = {};
  TEST_ASSERT_TRUE(devapi::json::stringField(body, len(body), "gate_key", gateKey, sizeof(gateKey)));
  TEST_ASSERT_EQUAL_STRING("front-door", gateKey);
}

/// `reason` is an enum the server picks, and it is sent BEFORE `court_number`
/// and `granted_seconds` in every activate response. A reason string equal to
/// either key name leaves the court box reading the response as malformed —
/// which is a refusal with no court and no relay time, not a wrong court.
void test_a_reason_that_names_a_key_does_not_hide_the_court_or_the_grant() {
  const char* body = "{\"activated\":true,\"reason\":\"court_number\",\"court_number\":3,"
                     "\"booking_id\":\"3fa85f64-5717-4562-b3fc-2c963f66afa6\",\"granted_seconds\":2700}";

  uint32_t court = 0U;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(body, len(body), "court_number", court));
  TEST_ASSERT_EQUAL_UINT32(3U, court);

  uint32_t granted = 0U;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(body, len(body), "granted_seconds", granted));
  TEST_ASSERT_EQUAL_UINT32(2700U, granted);
}

/// The same shape against a boolean. Generic rather than drawn from a live
/// response — no body the API serves today puts a string before `opened` or
/// `activated` that could carry its name — but the scanner is shared and the
/// next body to need one is not this suite's to predict.
void test_a_string_value_that_names_a_key_does_not_hide_a_boolean() {
  const char* body = "{\"reason\":\"opened\",\"opened\":false,\"unlock_seconds\":0}";

  bool opened = true;
  TEST_ASSERT_TRUE(devapi::json::boolField(body, len(body), "opened", opened));
  TEST_ASSERT_FALSE(opened);
}

// ---------------------------------------------------------------------------
// findObject — bounding a read to ONE object, which the flat scan cannot do
// ---------------------------------------------------------------------------

/// Both ends. `findKey` plus a read from there bounds the scan at the object's
/// START only, so a key added to the document after the object closed would be
/// adopted as if it were inside it — which for the gate is a lock driven for
/// somebody else's number.
void test_find_object_bounds_the_read_at_both_ends() {
  const char* body = "{\"kind\":\"gate\",\"gate\":{\"reason\":\"ok\"},\"unlock_seconds\":29,\"roster\":[]}";

  size_t innerLen = 0U;
  const size_t pos = devapi::json::findObject(body, len(body), "gate", innerLen);
  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound, pos);

  uint32_t seconds = 0U;
  TEST_ASSERT_FALSE(devapi::json::unsignedField(body + pos, innerLen, "unlock_seconds", seconds));
}

/// A nested object's braces must not close the outer one early.
void test_find_object_matches_braces_through_a_nested_object() {
  const char* body = "{\"gate\":{\"limits\":{\"max\":9},\"unlock_seconds\":6},\"roster\":[]}";

  size_t innerLen = 0U;
  const size_t pos = devapi::json::findObject(body, len(body), "gate", innerLen);
  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound, pos);

  uint32_t seconds = 0U;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(body + pos, innerLen, "unlock_seconds", seconds));
  TEST_ASSERT_EQUAL_UINT32(6U, seconds);
}

/// A brace inside a STRING is not a brace. `gate_key` is typed by an admin, so
/// a door called `}` is a door somebody will eventually create.
void test_find_object_ignores_braces_inside_a_string_value() {
  const char* body = "{\"gate\":{\"gate_key\":\"}}}\",\"unlock_seconds\":8}}";

  size_t innerLen = 0U;
  const size_t pos = devapi::json::findObject(body, len(body), "gate", innerLen);
  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound, pos);

  uint32_t seconds = 0U;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(body + pos, innerLen, "unlock_seconds", seconds));
  TEST_ASSERT_EQUAL_UINT32(8U, seconds);
}

/// Absent, not-an-object, and never-balancing all report absence, and leave the
/// caller's length alone so it cannot read a span nobody measured.
void test_find_object_reports_absence_rather_than_guessing() {
  size_t innerLen = 4242U;

  const char* absent = "{\"kind\":\"gate\"}";
  TEST_ASSERT_EQUAL(devapi::json::kNotFound, devapi::json::findObject(absent, len(absent), "gate", innerLen));

  const char* notObject = "{\"gate\":[1,2]}";
  TEST_ASSERT_EQUAL(devapi::json::kNotFound,
                    devapi::json::findObject(notObject, len(notObject), "gate", innerLen));

  const char* unbalanced = "{\"gate\":{\"unlock_seconds\":3";
  TEST_ASSERT_EQUAL(devapi::json::kNotFound,
                    devapi::json::findObject(unbalanced, len(unbalanced), "gate", innerLen));

  TEST_ASSERT_EQUAL_UINT32(4242U, static_cast<uint32_t>(innerLen));
}

/// An empty object is an object: present, with nothing in it.
void test_find_object_reads_an_empty_object_as_present_and_empty() {
  const char* body = "{\"gate\":{},\"roster\":[]}";

  size_t innerLen = 4242U;
  const size_t pos = devapi::json::findObject(body, len(body), "gate", innerLen);
  TEST_ASSERT_NOT_EQUAL(devapi::json::kNotFound, pos);
  TEST_ASSERT_EQUAL_UINT32(0U, static_cast<uint32_t>(innerLen));
}

// ---------------------------------------------------------------------------
// stringField and where a value ends
// ---------------------------------------------------------------------------

/// `copyQuoted` and `findKey` must agree about where a string ends, or the
/// library has two different ideas of the same document. The escape pair is
/// copied VERBATIM rather than decoded: this is a scanner, it does not own a
/// JSON string's semantics, and half-decoding is how a value that differs from
/// what the server sent gets acted on as fact.
void test_string_field_runs_to_the_real_closing_quote_across_an_escape() {
  const char* body = "{\"gate_key\":\"front\\\"door\",\"heartbeat_seconds\":60}";

  char gateKey[32] = {};
  TEST_ASSERT_TRUE(devapi::json::stringField(body, len(body), "gate_key", gateKey, sizeof(gateKey)));
  TEST_ASSERT_EQUAL_STRING("front\\\"door", gateKey);

  // And the key after it is still reachable, which is the half that matters.
  uint32_t seconds = 0U;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(body, len(body), "heartbeat_seconds", seconds));
  TEST_ASSERT_EQUAL_UINT32(60U, seconds);
}

/// REFUSES RATHER THAN TRUNCATES, across an escape too. An escape pair costs
/// two bytes of the buffer because it is copied as two bytes.
void test_string_field_refuses_a_value_that_does_not_fit_across_an_escape() {
  const char* body = "{\"gate_key\":\"front\\\"door\"}";

  char small[8] = {};
  TEST_ASSERT_FALSE(devapi::json::stringField(body, len(body), "gate_key", small, sizeof(small)));
}

/// An unterminated value is reported, never half-read.
void test_string_field_refuses_an_unterminated_value() {
  const char* body = "{\"gate_key\":\"front-do";

  char gateKey[32] = {};
  TEST_ASSERT_FALSE(devapi::json::stringField(body, len(body), "gate_key", gateKey, sizeof(gateKey)));
}

// -------------------------------------------------------------------------
// isCompleteObject — the question a caller asks before REPLACING something
// -------------------------------------------------------------------------

void test_is_complete_object_accepts_a_whole_document() {
  const char* whole[] = {
      "{}",
      "  {\"a\":1}  \n",
      "{\"roster\":[\"TOKALICE|1|0|3600\",\"TOKBOB|2|0|3600\"]}",
      "{\"config\":{\"button_map\":[\"court:A\"]},\"gate\":{\"unlock_seconds\":3}}",
      // Braces and brackets inside a VALUE are bytes, not structure.
      "{\"reason\":\"}]}{\"}",
      // ...including behind an escape, which is what endOfString is for.
      "{\"reason\":\"he said \\\"}\\\"\"}",
  };
  for (const char* body : whole) {
    TEST_ASSERT_TRUE_MESSAGE(devapi::json::isCompleteObject(body, len(body)), body);
  }
}

void test_is_complete_object_refuses_anything_the_transport_may_have_cut() {
  const char* cut[] = {
      "",
      "{",
      "{\"roster\":[",
      "{\"roster\":[\"TOKALICE|1|0|3600\"",  // inside the array
      "{\"roster\":[\"TOKALICE|1|0|3600\"]", // after the array, before the brace
      "{\"roster\":[\"TOKALICE|1|0|36",      // inside a string
      "{\"config\":{\"button_map\":[]}",     // one level short
      "{\"gate_key\":\"front-do",            // the unterminated-string case
      "{\"a\":1}{\"b\":2}",                  // two documents: not one object
      "{\"a\":1} trailing",                  // a trailing byte is not whitespace
      "[\"TOKALICE|1|0|3600\"]",             // an array is not an object
      "}",                                   // a closer with nothing open
      "null",
  };
  for (const char* body : cut) {
    TEST_ASSERT_FALSE_MESSAGE(devapi::json::isCompleteObject(body, len(body)), body);
  }

  TEST_ASSERT_FALSE(devapi::json::isCompleteObject(nullptr, 0U));
}

/// A CLOSER THAT DOES NOT MATCH ITS OPENER IS NOT A CLOSE.
///
/// The depth counter was a COUNT: `{` and `[` both raised it, `}` and `]` both
/// lowered it, so `{"a":1]` reached depth zero and the whole document was
/// declared complete. Nothing downstream of that reads a bracket as a brace, so
/// the wrong thing this admits is not a misparse — it is the CUT BODY this
/// function exists to refuse, arriving with a stray `]` at the end of the
/// buffer and being committed as a whole roster.
///
/// The openers are remembered now, one bit per level. Shared with the court
/// box: both firmwares ask this before replacing a roster with what arrived.
void test_is_complete_object_refuses_a_closer_that_does_not_match_its_opener() {
  const char* mismatched[] = {
      "{\"a\":1]",
      "{\"a\":[1}",
      "{\"a\":[1}]",
      "{\"roster\":[\"TOKALICE|1|0|3600\"}",
      "{\"config\":{\"button_map\":[]]}",
      "[1}",
  };
  for (const char* body : mismatched) {
    TEST_ASSERT_FALSE_MESSAGE(devapi::json::isCompleteObject(body, len(body)), body);
  }

  // And the matched forms of the same shapes still pass, so the fix is a
  // narrowing rather than a refusal of nesting.
  const char* matched[] = {
      "{\"a\":1}",
      "{\"a\":[1]}",
      "{\"roster\":[\"TOKALICE|1|0|3600\"]}",
      "{\"config\":{\"button_map\":[]}}",
  };
  for (const char* body : matched) {
    TEST_ASSERT_TRUE_MESSAGE(devapi::json::isCompleteObject(body, len(body)), body);
  }
}

/// Nesting deeper than the opener stack holds is refused rather than guessed
/// at. Nothing in either contract nests past three, and a body that does is one
/// this reader does not understand — which is the same answer it gives a cut
/// one, for the same reason.
void test_is_complete_object_refuses_nesting_it_cannot_track() {
  char deep[160] = {};
  size_t n = 0U;
  for (; n < 40U; ++n) {
    deep[n] = '{';
  }
  for (size_t i = 0U; i < 40U; ++i) {
    deep[n] = '}';
    ++n;
  }
  TEST_ASSERT_FALSE_MESSAGE(devapi::json::isCompleteObject(deep, n), "40 levels is past what is tracked");

  // The depth an actual heartbeat reaches, several times over, still passes.
  const char* nested = "{\"a\":{\"b\":{\"c\":[{\"d\":[1,2]}]}}}";
  TEST_ASSERT_TRUE(devapi::json::isCompleteObject(nested, len(nested)));
}

/// The length governs, not a NUL. A caller holding a 4608-byte buffer with a
/// 4096-byte response in it passes the response's length, and a body that
/// happens to sit in a longer buffer must not be read past what arrived.
void test_is_complete_object_reads_only_the_length_it_is_given() {
  const char body[] = "{\"a\":1}{\"b\":2}";
  TEST_ASSERT_TRUE(devapi::json::isCompleteObject(body, 7U));
  TEST_ASSERT_FALSE(devapi::json::isCompleteObject(body, 6U));
  TEST_ASSERT_FALSE(devapi::json::isCompleteObject(body, len(body)));
}

} // namespace

/// G4 / B2. The top-level family reads ONE object's own members and nothing
/// nested inside them — including when the decoy comes FIRST, which is the
/// ordering a flat scan actually loses to.
void test_top_level_readers_see_only_the_outermost_objects_members() {
  bool flag = false;
  uint32_t number = 0U;
  char text[32] = {};
  size_t innerLen = 0U;

  // The plain case: both families agree when there is nothing to disagree about.
  const char* plain = "{\"opened\":true,\"unlock_seconds\":3,\"reason\":\"ok\"}";
  TEST_ASSERT_TRUE(devapi::json::topLevelBoolField(plain, strlen(plain), "opened", flag));
  TEST_ASSERT_TRUE(flag);
  TEST_ASSERT_TRUE(devapi::json::topLevelUnsignedField(plain, strlen(plain), "unlock_seconds", number));
  TEST_ASSERT_EQUAL_UINT32(3U, number);
  TEST_ASSERT_TRUE(devapi::json::topLevelStringField(plain, strlen(plain), "reason", text, sizeof(text)));
  TEST_ASSERT_EQUAL_STRING("ok", text);

  // A NESTED key is absent, in both orders and through both container kinds.
  const char* nestedAfter = "{\"a\":1,\"outer\":{\"opened\":true}}";
  const char* nestedFirst = "{\"outer\":{\"opened\":true},\"a\":1}";
  const char* inAnArray = "{\"rows\":[{\"opened\":true}],\"a\":1}";
  const char* topLevelArray = "[{\"opened\":true}]";
  const char* bodies[] = {nestedAfter, nestedFirst, inAnArray, topLevelArray};
  for (size_t i = 0U; i < sizeof(bodies) / sizeof(bodies[0]); ++i) {
    flag = false;
    TEST_ASSERT_FALSE_MESSAGE(devapi::json::topLevelBoolField(bodies[i], strlen(bodies[i]), "opened", flag),
                              bodies[i]);
    // And the FLAT family still finds it, which is what the court box depends
    // on and is why both exist.
    if (bodies[i] != topLevelArray) {
      flag = false;
      TEST_ASSERT_TRUE_MESSAGE(devapi::json::boolField(bodies[i], strlen(bodies[i]), "opened", flag),
                               bodies[i]);
    }
  }

  // A TOP-LEVEL FALSE BEATS A NESTED TRUE, whichever comes first.
  const char* refusalWithDecoy = "{\"detail\":{\"opened\":true},\"opened\":false}";
  flag = true;
  TEST_ASSERT_TRUE(
      devapi::json::topLevelBoolField(refusalWithDecoy, strlen(refusalWithDecoy), "opened", flag));
  TEST_ASSERT_FALSE(flag);

  // A decoy STRING VALUE that spells the key is not a key.
  const char* decoyValue = "{\"reason\":\"opened\",\"opened\":true}";
  flag = false;
  TEST_ASSERT_TRUE(devapi::json::topLevelBoolField(decoyValue, strlen(decoyValue), "opened", flag));
  TEST_ASSERT_TRUE(flag);

  // Escapes and braces inside a value cannot put the member walk out of phase.
  const char* hostile = "{\"note\":\"a\\\"b{\\\"opened\\\":true}\",\"opened\":false}";
  flag = true;
  TEST_ASSERT_TRUE(devapi::json::topLevelBoolField(hostile, strlen(hostile), "opened", flag));
  TEST_ASSERT_FALSE(flag);

  // The object and array finders are scoped the same way.
  const char* objects = "{\"meta\":{\"gate\":{\"unlock_seconds\":30}},\"gate\":{\"unlock_seconds\":3}}";
  const size_t at = devapi::json::findTopLevelObject(objects, strlen(objects), "gate", innerLen);
  TEST_ASSERT_TRUE(at != devapi::json::kNotFound);
  number = 0U;
  TEST_ASSERT_TRUE(devapi::json::unsignedField(objects + at, innerLen, "unlock_seconds", number));
  TEST_ASSERT_EQUAL_UINT32(3U, number);

  const char* arrays = "{\"meta\":{\"roster\":[\"DECOY|0|0|9\"]},\"roster\":[\"REAL|0|0|9\"]}";
  size_t element = devapi::json::findTopLevelArray(arrays, strlen(arrays), "roster");
  TEST_ASSERT_TRUE(element != devapi::json::kNotFound);
  TEST_ASSERT_TRUE(devapi::json::nextStringElement(arrays, strlen(arrays), element, text, sizeof(text)));
  TEST_ASSERT_EQUAL_STRING("REAL|0|0|9", text);

  // A body that is not one object at all yields nothing, rather than guessing.
  const char* notAnObject = "\"opened\":true";
  flag = false;
  TEST_ASSERT_FALSE(devapi::json::topLevelBoolField(notAnObject, strlen(notAnObject), "opened", flag));
  TEST_ASSERT_TRUE(devapi::json::findTopLevelKey(nullptr, 0U, "opened") == devapi::json::kNotFound);
  TEST_ASSERT_TRUE(devapi::json::findTopLevelKey(plain, strlen(plain), "") == devapi::json::kNotFound);
}

void setUp() {
}

void tearDown() {
}

int main(int, char**) {
  UNITY_BEGIN();

  RUN_TEST(test_find_key_skips_a_quoted_string_that_is_a_value);
  RUN_TEST(test_find_key_skips_a_quoted_string_that_is_an_array_element);
  RUN_TEST(test_find_key_does_not_read_a_colon_inside_a_string_as_a_keys_colon);
  RUN_TEST(test_find_key_finds_a_nested_key_by_flat_scan);
  RUN_TEST(test_find_key_allows_whitespace_between_the_key_and_its_colon);
  RUN_TEST(test_find_key_is_not_fooled_by_an_escaped_quote_inside_a_value);
  RUN_TEST(test_find_key_is_not_fooled_by_an_escaped_backslash_ending_a_value);
  RUN_TEST(test_find_key_reports_an_unterminated_string_rather_than_scanning_past_it);
  RUN_TEST(test_find_key_needs_the_colon_to_be_present);

  RUN_TEST(test_a_tenant_slug_that_names_a_key_does_not_hide_the_heartbeat_interval);
  RUN_TEST(test_a_tenant_slug_that_names_a_key_does_not_hide_the_roster);
  RUN_TEST(test_a_device_code_that_names_a_key_does_not_hide_the_gate_key);
  RUN_TEST(test_a_reason_that_names_a_key_does_not_hide_the_court_or_the_grant);
  RUN_TEST(test_a_string_value_that_names_a_key_does_not_hide_a_boolean);

  RUN_TEST(test_find_object_bounds_the_read_at_both_ends);
  RUN_TEST(test_find_object_matches_braces_through_a_nested_object);
  RUN_TEST(test_find_object_ignores_braces_inside_a_string_value);
  RUN_TEST(test_find_object_reports_absence_rather_than_guessing);
  RUN_TEST(test_find_object_reads_an_empty_object_as_present_and_empty);

  RUN_TEST(test_string_field_runs_to_the_real_closing_quote_across_an_escape);
  RUN_TEST(test_string_field_refuses_a_value_that_does_not_fit_across_an_escape);
  RUN_TEST(test_string_field_refuses_an_unterminated_value);

  RUN_TEST(test_is_complete_object_accepts_a_whole_document);
  RUN_TEST(test_is_complete_object_refuses_anything_the_transport_may_have_cut);
  RUN_TEST(test_is_complete_object_refuses_a_closer_that_does_not_match_its_opener);
  RUN_TEST(test_is_complete_object_refuses_nesting_it_cannot_track);
  RUN_TEST(test_is_complete_object_reads_only_the_length_it_is_given);
  RUN_TEST(test_top_level_readers_see_only_the_outermost_objects_members);

  return UNITY_END();
}
