#include "bridgelogic/ScreenScript.h"

#include <stdio.h>
#include <string.h>

#include "devapi/Json.h"

namespace bridgelogic {

namespace {

/// What fills the one variable slot a row may have.
///
/// ONE slot per row, deliberately. A row with two of them is a row nobody can
/// reason about the width of, and the width is the whole of the layout
/// contract. Where a screen genuinely needs two values — the card's booked
/// window — they go in as one pair (FromTo) with their own separator.
enum class RowArg : uint8_t {
  None = 0U,
  /// The relay as A-D. Never the index: rule 4.
  CourtLetter,
  /// The club's own court number.
  CourtNumber,
  Minutes,
  /// `HH:MM`s. An EMPTY one blanks the WHOLE row, prefix and suffix included —
  /// "Ends " on its own is a promise with the answer missing.
  EndsAt,
  AtTime,
  FromTo,
  /// `member_display`, or kNoName.
  Name,
  /// The four green buttons, then the four black ones, from the live map.
  CourtCells,
  DurationCells,
  /// `amount_label`, as the server rendered it.
  Amount,
};

struct RowSpec {
  const char* prefix;
  RowArg arg;
  const char* suffix;
};

struct ScreenSpec {
  ScreenId id;
  RowSpec rows[proto::kMaxRows];
  uint16_t holdSeconds;
  uint8_t flags;
};

/// The hold class each default second-count belongs to. Kept beside the
/// defaults rather than derived from them: recognising a hold by its value is a
/// mapping that breaks silently the day two defaults coincide.
constexpr HoldClass holdClassFor(uint16_t holdSeconds) {
  return holdSeconds == kChoiceSeconds
             ? HoldClass::Choice
             : (holdSeconds == kCardSeconds
                    ? HoldClass::Card
                    : (holdSeconds == kWaitSeconds ? HoldClass::Wait : HoldClass::Revert));
}

constexpr RowSpec kBlank = {"", RowArg::None, ""};

/// EVERY SCREEN THIS BOX CAN PAINT, in one place, indexed by ScreenId.
///
/// The wording is held to the layout contract in ScreenScript.h and the
/// contract is a test over this table, not a review of it. Several rows read
/// shorter than they would in a design document: rows 0-1 are bounded at
/// court::kSafeSubsetCols (16) so a 1602 degrades rather than lies, and row 3
/// is bounded at 16 so the countdown zone stays clear. A longer sentence that
/// clips to half of itself is worse than a short one that does not.
constexpr ScreenSpec kScreenSpecs[kScreenCount] = {
    // --- a court came on ----------------------------------------------------
    {ScreenId::Grant,
     {{"COURT ", RowArg::CourtLetter, " IS ON"},
      {"", RowArg::Minutes, " MINUTES"},
      {"Ends ", RowArg::EndsAt, ""},
      {"ENJOY YOUR GAME", RowArg::None, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    // A rescan mid-game. The same zones as a grant, and row 1 is what makes it
    // a different screen: the member gets the number they actually wanted.
    {ScreenId::AlreadyOn,
     {{"COURT ", RowArg::CourtLetter, " IS ON"},
      {"", RowArg::Minutes, " MINUTES LEFT"},
      {"Ends ", RowArg::EndsAt, ""},
      {"ENJOY YOUR GAME", RowArg::None, ""}},
     kRevertSeconds,
     kShowFlagCountdown},

    // --- refusals -----------------------------------------------------------
    {ScreenId::NoBooking,
     {{"NO BOOKING FOUND", RowArg::None, ""},
      {"Nothing booked", RowArg::None, ""},
      {"You can buy time", RowArg::None, ""},
      {"", RowArg::CourtCells, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    {ScreenId::InsufficientBalance,
     {{"TOO FEW MINUTES", RowArg::None, ""},
      {"Buy more time", RowArg::None, ""},
      {"Buy in the app", RowArg::None, ""},
      {"SCAN WHEN READY", RowArg::None, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    // The screen the contract test caught while this table was being written.
    // `WRONG COURT` / `Your booking is on` clips at column 16 to "Your booking
    // is" — a sentence that stops before the only word that matters. The court
    // NUMBER moves up to row 1, where sixteen columns can hold it, and the
    // softer prose moves down to rows 2-3 where it is enrichment.
    {ScreenId::WrongCourt,
     {{"WRONG COURT", RowArg::None, ""},
      {"GO TO COURT ", RowArg::CourtNumber, ""},
      {"Your booking is on", RowArg::None, ""},
      {"court ", RowArg::CourtNumber, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    {ScreenId::TooEarly,
     {{"TOO EARLY", RowArg::None, ""},
      {"Back in ", RowArg::Minutes, " min"},
      {"at ", RowArg::AtTime, ""},
      {"SCAN THEN", RowArg::None, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    {ScreenId::NotRecognised,
     {{"CODE NOT KNOWN", RowArg::None, ""},
      {"Get a fresh code", RowArg::None, ""},
      {"in the Crusaders app", RowArg::None, ""},
      {"THEN SCAN AGAIN", RowArg::None, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    {ScreenId::SlotEnded,
     {{"THAT SLOT ENDED", RowArg::None, ""},
      {"Or buy time here", RowArg::None, ""},
      {"Book in the app", RowArg::None, ""},
      {"", RowArg::CourtCells, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    {ScreenId::CourtInUse,
     {{"COURT ", RowArg::CourtLetter, " IN USE"},
      {"Someone playing", RowArg::None, ""},
      {"Try another court", RowArg::None, ""},
      {"", RowArg::CourtCells, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    // The court is EMPTY and the next player is imminent, which is a different
    // sentence from "in use" and sends the member somewhere different.
    {ScreenId::NoTimeAvailable,
     {{"NO TIME ON ", RowArg::CourtLetter, ""},
      {"The next booking", RowArg::None, ""},
      {"starts at ", RowArg::AtTime, ""},
      {"", RowArg::CourtCells, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    // Row 3 is the DURATION row here, which is the whole point: the member can
    // fix this themselves by pressing a shorter button, and the row names which
    // buttons those are on this club's panel.
    {ScreenId::MinutesOutOfRange,
     {{"THAT IS TOO LONG", RowArg::None, ""},
      {"Press less time", RowArg::None, ""},
      {"Most now: ", RowArg::Minutes, " min"},
      {"", RowArg::DurationCells, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    {ScreenId::ClubClosed,
     {{"CLUB CLOSED", RowArg::None, ""},
      {"Opens at ", RowArg::AtTime, ""},
      {"Come back then", RowArg::None, ""},
      {"SEE YOU LATER", RowArg::None, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    {ScreenId::PurchaseEnded,
     {{"PURCHASE ENDED", RowArg::None, ""},
      {"Buy again", RowArg::None, ""},
      {"Press a court to buy", RowArg::None, ""},
      {"", RowArg::CourtCells, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    // The API sold the court, could not open it, and UNDID the sale before this
    // answer was written. The money is back and the court is FREE, so the old
    // "COURT NOT FREE" was true for as long as the refused booking sat on the
    // court and false the moment the undo landed.
    {ScreenId::ActivationRefused,
     {{"COULD NOT START", RowArg::None, ""},
      {"Nothing charged", RowArg::None, ""},
      {"Please scan again", RowArg::None, ""},
      {"SCAN WHEN READY", RowArg::None, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    // Booked courts still work with no network, and saying so is the difference
    // between a member scanning again and a member walking to the desk.
    {ScreenId::NoConnection,
     {{"NO CONNECTION", RowArg::None, ""},
      {"Booked courts OK", RowArg::None, ""},
      {"Scan again to play", RowArg::None, ""},
      {"SCAN WHEN READY", RowArg::None, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    {ScreenId::SeeTheDesk,
     {{"SEE THE DESK", RowArg::None, ""},
      {"Sorry, try later", RowArg::None, ""},
      {"The box could not", RowArg::None, ""},
      {"SORRY", RowArg::None, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    {ScreenId::OnNotSent,
     {{"PLEASE TRY AGAIN", RowArg::None, ""},
      {"Lights did not", RowArg::None, ""},
      {"switch on", RowArg::None, ""},
      {"SCAN WHEN READY", RowArg::None, ""}},
     kRevertSeconds,
     kShowFlagCountdown},

    // --- the two that were STUCK FOREVER --------------------------------
    // Both of these were painted with a bare `!LCD` from the composition root
    // and nothing ever replaced them: no revert, no deadline, no next frame
    // until somebody scanned. A member who pressed OFF on the wrong court left
    // `NOT YOUR COURT` on the glass for the rest of the evening.
    {ScreenId::NotYourCourt,
     {{"NOT YOUR COURT", RowArg::None, ""},
      {"Not your booking", RowArg::None, ""},
      {"Another member's", RowArg::None, ""},
      {"NOTHING CHANGED", RowArg::None, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    {ScreenId::ScanFirst,
     {{"SCAN YOUR CODE", RowArg::None, ""},
      {"Then a court", RowArg::None, ""},
      {"and a time", RowArg::None, ""},
      {"SCAN WHEN READY", RowArg::None, ""}},
     kRevertSeconds,
     kShowFlagCountdown},

    // --- mid-interaction ----------------------------------------------------
    // The one screen whose hold is the CHOICE window rather than the revert
    // window, and whose countdown is the point: a half-made purchase is the one
    // thing on this box a timeout can lose, so the member can see it going.
    {ScreenId::ChooseTime,
     {{"COURT ", RowArg::CourtLetter, ""},
      {"HOW LONG?", RowArg::None, ""},
      {"Press a black button", RowArg::None, ""},
      {"", RowArg::DurationCells, ""}},
     kChoiceSeconds,
     kShowFlagCountdown},
    // Six seconds: the 4 s HTTP bound plus slack. Never indefinite — this one
    // sits in front of a blocking call that can end in a reset, which is
    // exactly how a screen becomes permanent.
    {ScreenId::OneMoment,
     {{"ONE MOMENT", RowArg::None, ""},
      {"Buying your time", RowArg::None, ""},
      kBlank,
      {"PLEASE WAIT", RowArg::None, ""}},
     kWaitSeconds,
     0U},

    // --- the card -----------------------------------------------------------
    // Scan -> card -> court -> time. For a booked member the last two are
    // answered before they arrive, so the card states them and the lights come
    // on: there is no OK button on this panel to confirm with, and a button
    // that could name its own court would open any court in the club.
    {ScreenId::CardBooked,
     {{"HI ", RowArg::Name, ""},
      {"COURT ", RowArg::CourtLetter, ""},
      {"Booked ", RowArg::FromTo, ""},
      {"LIGHTS COMING ON", RowArg::None, ""}},
     kCardSeconds,
     0U},
    {ScreenId::CardNoBooking,
     {{"HI ", RowArg::Name, ""},
      {"NO BOOKING TODAY", RowArg::None, ""},
      {"You can buy time", RowArg::None, ""},
      {"", RowArg::CourtCells, ""}},
     kChoiceSeconds,
     kShowFlagCountdown},
    // The offline roster path has no member name and never will: the roster
    // carries tokens and courts, and sixteen names would not fit the 2048-byte
    // heartbeat body they would have to arrive in. `BOOKING FOUND` is honest.
    {ScreenId::CardBookedOffline,
     {{"BOOKING FOUND", RowArg::None, ""},
      {"COURT ", RowArg::CourtLetter, ""},
      {"Booked ", RowArg::FromTo, ""},
      {"LIGHTS COMING ON", RowArg::None, ""}},
     kCardSeconds,
     0U},

    // --- D10: pay for somebody else's court ----------------------------------
    // The founder's words are `CT2 BOOKED / PAY 50 MIN? PRESS CT2` (minutes, P13
    // §8). On the fitted 20x4 they would not fit as two lines: row 1 would be
    // twenty-two columns and the safe-subset contract clips it at sixteen to
    // `PAY 50 MIN? PRES` — a question with the instruction cut off. So the same
    // words run down three rows: the verdict (row 0), the question (row 1), the
    // instruction (row 2). On a 1602 the member still reads `CT2 BOOKED / PAY 50
    // MIN?`, which is true and complete as a question; the second press is the
    // only answer there is. The widest question is `PAY 9999 MIN?`, thirteen.
    {ScreenId::PayForQuote,
     {{"CT", RowArg::CourtNumber, " BOOKED"},
      {"PAY ", RowArg::Amount, " MIN?"},
      {"PRESS CT", RowArg::CourtNumber, " TO PAY"},
      {"", RowArg::CourtCells, ""}},
     kChoiceSeconds,
     kShowFlagCountdown},
    {ScreenId::PayForPaid,
     {{"PAID FOR CT", RowArg::CourtNumber, ""},
      {"", RowArg::Amount, " MIN PAID"},
      {"Booker refunded", RowArg::None, ""},
      {"THANK YOU", RowArg::None, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    // The founder's `SPLIT - PAY IN APP` is eighteen columns; the safe subset
    // holds sixteen. The verdict and the instruction take a row each, and the
    // instruction keeps the founder's words.
    {ScreenId::PayForSplit,
     {{"SPLIT BOOKING", RowArg::None, ""},
      {"PAY IN APP", RowArg::None, ""},
      {"Each player's share", RowArg::None, ""},
      {"NOTHING CHARGED", RowArg::None, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    {ScreenId::PayForNothingToPay,
     {{"NOTHING TO PAY", RowArg::None, ""},
      {"Already paid for", RowArg::None, ""},
      kBlank,
      {"NOTHING CHARGED", RowArg::None, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    {ScreenId::PayForPriceChanged,
     {{"PRICE CHANGED", RowArg::None, ""},
      {"Nothing charged", RowArg::None, ""},
      {"Press court again", RowArg::None, ""},
      {"", RowArg::CourtCells, ""}},
     kRevertSeconds,
     kShowFlagCountdown},
    {ScreenId::PayForWorking,
     {{"ONE MOMENT", RowArg::None, ""},
      {"Asking the club", RowArg::None, ""},
      kBlank,
      {"PLEASE WAIT", RowArg::None, ""}},
     kWaitSeconds,
     0U},
    // The activation's wait (D8-2). Same class and hold as OneMoment — six
    // seconds in front of a blocking call — with words true for whoever
    // scanned: nothing is being bought yet. Row 1 is thirteen columns, inside
    // the safe subset; "Checking your code" would be eighteen and clip.
    {ScreenId::CheckingCode,
     {{"ONE MOMENT", RowArg::None, ""},
      {"Checking code", RowArg::None, ""},
      kBlank,
      {"PLEASE WAIT", RowArg::None, ""}},
     kWaitSeconds,
     0U},
};

/// kScreenSpecs is indexed by the ScreenId value, so a row in the wrong place
/// would silently give every screen somebody else's words. Recursive and one
/// return statement because a constexpr function with a loop in it is C++14,
/// and both Arduino cores compile this tree at gnu++11 — the same reason
/// proto::verbSpecsAreInEnumOrder is written this way. Do not "simplify" it.
constexpr bool screenSpecsAreInEnumOrder(size_t i = 0U) {
  return i >= kScreenCount ||
         (kScreenSpecs[i].id == static_cast<ScreenId>(i) && screenSpecsAreInEnumOrder(i + 1U));
}

static_assert(screenSpecsAreInEnumOrder(), "kScreenSpecs must be indexed by ScreenId");

/// Appends what fits and terminates. The one place in this file that touches
/// the row's capacity, so the clip rule is stated once.
void append(char* out, size_t cap, const char* text) {
  if (text == nullptr || text[0] == '\0') {
    return;
  }
  const size_t at = strlen(out);
  if (at + 1U >= cap) {
    return;
  }
  snprintf(out + at, cap - at, "%s", text);
}

void appendU32(char* out, size_t cap, uint32_t value) {
  char digits[12] = {};
  snprintf(digits, sizeof(digits), "%lu", static_cast<unsigned long>(value));
  append(out, cap, digits);
}

void appendChar(char* out, size_t cap, char c) {
  const char text[2] = {c, '\0'};
  append(out, cap, text);
}

char courtLetter(uint8_t court) {
  // A court this box does not drive is '?' rather than a letter past D. It
  // cannot reach the glass through any path here, and printing 'E' would be a
  // court that does not exist told to a member who would go looking for it.
  return court < 4U ? static_cast<char>('A' + court) : '?';
}

/// True when `arg` is a time, which blanks the WHOLE row when it is not known.
bool isTimeArg(RowArg arg) {
  return arg == RowArg::EndsAt || arg == RowArg::AtTime || arg == RowArg::FromTo;
}

const char* timeFor(RowArg arg, const ScreenFacts& facts) {
  if (arg == RowArg::EndsAt) {
    return facts.endsAt;
  }
  if (arg == RowArg::AtTime) {
    return facts.atTime;
  }
  return facts.fromTime;
}

/// The four cells of the green or the black row, from the live map.
void appendCells(RowArg arg, const ScreenFacts& facts, char* out, size_t cap) {
  const court::ButtonMap fallback;
  const court::ButtonMap& map = facts.buttons != nullptr ? *facts.buttons : fallback;
  renderActionRow(map, arg == RowArg::CourtCells ? kCourtCellsFrom : kDurationCellsFrom, out, cap);
}

/// The row's variable part, appended to `out`.
void appendArg(RowArg arg, const ScreenFacts& facts, char* out, size_t cap) {
  switch (arg) {
  case RowArg::None:
    return;
  case RowArg::CourtLetter:
    appendChar(out, cap, courtLetter(facts.court));
    return;
  case RowArg::CourtNumber:
    appendU32(out, cap, facts.courtNumber > 0 ? static_cast<uint32_t>(facts.courtNumber) : 0U);
    return;
  case RowArg::Minutes:
    appendU32(out, cap, facts.minutes);
    return;
  case RowArg::EndsAt:
  case RowArg::AtTime:
    append(out, cap, timeFor(arg, facts));
    return;
  case RowArg::FromTo:
    append(out, cap, facts.fromTime);
    append(out, cap, "-");
    append(out, cap, facts.toTime);
    return;
  case RowArg::Name:
    append(out, cap, facts.name[0] == '\0' ? kNoName : facts.name);
    return;
  case RowArg::Amount:
    append(out, cap, facts.amount);
    return;
  case RowArg::CourtCells:
  case RowArg::DurationCells:
    appendCells(arg, facts, out, cap);
    return;
  }
}

void renderRow(const RowSpec& spec, const ScreenFacts& facts, char* out, size_t cap) {
  out[0] = '\0';
  if (isTimeArg(spec.arg) && timeFor(spec.arg, facts)[0] == '\0') {
    // The clock is not trusted, so this row has nothing true to say. BLANK, not
    // "Ends " — a prefix with its answer missing is the one thing worse than
    // silence, because it reads as a screen that is still loading.
    return;
  }
  // The whole row, not the second half: a `FromTo` needs both ends.
  if (spec.arg == RowArg::FromTo && facts.toTime[0] == '\0') {
    return;
  }
  append(out, cap, spec.prefix);
  appendArg(spec.arg, facts, out, cap);
  append(out, cap, spec.suffix);
}

} // namespace

void renderActionRow(const court::ButtonMap& map, uint8_t from, char* out, size_t cap) {
  if (out == nullptr || cap == 0U) {
    return;
  }
  out[0] = '\0';
  size_t written = 0U;
  for (uint8_t cell = 0U; cell < 4U; ++cell) {
    const court::ButtonAction& action = map[static_cast<uint8_t>(from + cell)];
    char label[8] = {};
    if (action.kind == court::ButtonKind::SelectCourt) {
      snprintf(label, sizeof(label), "%c", courtLetter(action.court));
    } else if (action.kind == court::ButtonKind::GrantMinutes) {
      snprintf(label, sizeof(label), "%u", static_cast<unsigned>(action.minutes));
    }
    // `off` and `none` fall through with an empty label: a button that does
    // nothing must not advertise a duration somebody would press.
    if (label[0] == '\0') {
      continue;
    }
    const size_t at = static_cast<size_t>(cell) * kActionCellCols;
    if (at + strlen(label) >= cap) {
      return;
    }
    while (written < at) {
      out[written] = ' ';
      ++written;
    }
    snprintf(out + at, cap - at, "%s", label);
    written = at + strlen(label);
  }
}

void readMemberDisplay(const char* body, size_t len, ScreenFacts& facts) {
  facts.name[0] = '\0';
  if (body == nullptr || len == 0U) {
    return;
  }
  char name[kMaxMemberNameLen + 1U] = {};
  // TOP LEVEL, like every other field this box acts on: a `member_display`
  // nested inside a decoy object is a greeting for somebody else, and the
  // greeting is the member's only confirmation that the box knows who they are.
  //
  // REFUSES rather than truncates, which is why a name that will not fit falls
  // back to kNoName: half a name is a different member's.
  if (!devapi::json::topLevelStringField(body, len, "member_display", name, sizeof(name))) {
    return;
  }
  snprintf(facts.name, sizeof(facts.name), "%s", name);
}

HoldClass holdClassOf(ScreenId id) {
  const size_t index = static_cast<size_t>(id) < kScreenCount ? static_cast<size_t>(id)
                                                              : static_cast<size_t>(ScreenId::SeeTheDesk);
  return holdClassFor(kScreenSpecs[index].holdSeconds);
}

Screen screenFor(ScreenId id, const ScreenFacts& facts, const devlink::LcdSettings& settings) {
  Screen screen = screenFor(id, facts);
  uint32_t ms = 0U;
  switch (holdClassOf(id)) {
  case HoldClass::Revert:
    ms = settings.revertMs;
    break;
  case HoldClass::Choice:
    ms = settings.choiceMs;
    break;
  case HoldClass::Card:
    ms = settings.cardMs;
    break;
  case HoldClass::Wait:
    // Deliberately not a tenant setting. See the header.
    return screen;
  }
  uint32_t seconds = ms / 1000UL;
  if (seconds < proto::kShowHoldMinSeconds) {
    seconds = proto::kShowHoldMinSeconds;
  }
  if (seconds > proto::kShowHoldMaxSeconds) {
    seconds = proto::kShowHoldMaxSeconds;
  }
  screen.holdSeconds = static_cast<uint16_t>(seconds);
  return screen;
}

Screen screenFor(ScreenId id, const ScreenFacts& facts) {
  Screen screen;
  const size_t index = static_cast<size_t>(id) < kScreenCount ? static_cast<size_t>(id)
                                                              : static_cast<size_t>(ScreenId::SeeTheDesk);
  const ScreenSpec& spec = kScreenSpecs[index];
  for (size_t row = 0U; row < proto::kMaxRows; ++row) {
    renderRow(spec.rows[row], facts, screen.rows[row], sizeof(screen.rows[row]));
  }
  // Clamped here as well as by the factory and the decoder. Three clamps rather
  // than one because this is the value a test reads, and a test that reads an
  // unclamped number is a test that agrees with a screen the Mega will never
  // show.
  uint16_t hold = spec.holdSeconds;
  if (hold < proto::kShowHoldMinSeconds) {
    hold = proto::kShowHoldMinSeconds;
  }
  if (hold > proto::kShowHoldMaxSeconds) {
    hold = proto::kShowHoldMaxSeconds;
  }
  screen.holdSeconds = hold;
  screen.flags = spec.flags;
  return screen;
}

} // namespace bridgelogic
