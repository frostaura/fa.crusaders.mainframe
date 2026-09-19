#include "gatelogic/ResponseBody.h"

#include "timebase/TimeBase.h"

namespace gatelogic {

BodyResult readBody(IResponseStream& stream, hal::IClock& clock, uint32_t deadlineAtMs, int expectedLength,
                    char* out, size_t outCap) {
  if (out == nullptr || outCap == 0U) {
    return BodyResult::TooLarge;
  }
  out[0] = '\0';

  // REFUSED BEFORE A BYTE IS READ. The peer has already said how long it is,
  // and pulling a megabyte through a 4.6 KB buffer to discover it does not fit
  // spends the call's whole deadline learning something the first header line
  // said. `>=` and not `>`: the terminator needs a byte too.
  if (expectedLength != kUnknownBodyLength &&
      (expectedLength < 0 || static_cast<size_t>(expectedLength) >= outCap)) {
    return BodyResult::TooLarge;
  }

  size_t n = 0U;
  for (;;) {
    if (expectedLength != kUnknownBodyLength && n == static_cast<size_t>(expectedLength)) {
      break;
    }

    if (stream.available() > 0) {
      const int value = stream.read();
      if (value >= 0) {
        if (n + 1U >= outCap) {
          // NEVER TRUNCATED. Emptied, so a caller that ignores the result reads
          // an absent body rather than a plausible half of one.
          out[0] = '\0';
          return BodyResult::TooLarge;
        }
        out[n] = static_cast<char>(value);
        ++n;
        continue;
      }
      // available() said yes and read() said no. Not a spin: this falls into
      // the wait below, where the deadline is checked.
    }

    // Nothing to read. Either the body is over, or this is waiting for it.
    if (expectedLength == kUnknownBodyLength && !stream.connected() && stream.available() <= 0) {
      break;
    }
    if (tb::reached(clock.nowMs(), deadlineAtMs)) {
      out[0] = '\0';
      return BodyResult::Timeout;
    }
    stream.idle();
  }

  out[n] = '\0';
  return BodyResult::Ok;
}

} // namespace gatelogic
