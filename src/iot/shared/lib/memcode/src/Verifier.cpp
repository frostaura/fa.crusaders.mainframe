#include "memcode/Verifier.h"

namespace memcode {

const char* statusName(Status status) {
  switch (status) {
  case Status::Ok:
    return "ok";
  case Status::Malformed:
    return "malformed";
  case Status::NoClock:
    return "no_clock";
  case Status::NoKey:
    return "no_key";
  case Status::WrongCode:
    return "wrong_code";
  case Status::Replayed:
    return "replayed";
  }
  // Only from a status byte no enumerator covers.
  return "malformed";
}

} // namespace memcode
