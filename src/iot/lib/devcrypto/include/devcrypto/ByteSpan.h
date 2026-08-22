// Crusaders Mainframe — a pointer + length pair.
//
// WHY THIS EXISTS
// ---------------
// Every function here takes bytes it does not own. std::span is C++20 and the
// AVR toolchain is not, std::vector and String allocate, and passing raw
// (pointer, length) pairs everywhere pushes several signatures past the
// six-parameter complexity gate — at which point the parameters start getting
// swapped by accident, which for a signing key means a MAC that is merely
// wrong rather than one that fails to compile.
//
// Deliberately a plain aggregate: no constructors, no ownership, no lifetime
// claims. It never outlives the call it is passed to.

#ifndef CRUSADERS_DEVCRYPTO_BYTESPAN_H
#define CRUSADERS_DEVCRYPTO_BYTESPAN_H

#include <stddef.h>
#include <stdint.h>

namespace dc {

struct ByteSpan {
  const uint8_t* data = nullptr;
  size_t len = 0;
};

/// An empty span. `data` may legally be null when `len` is 0 — HMAC with an
/// empty key and SHA-256 of an empty body are both real corpus cases, so the
/// null-with-zero-length shape has to be safe rather than merely unlikely.
inline ByteSpan emptySpan() {
  return ByteSpan{nullptr, 0};
}

} // namespace dc

#endif // CRUSADERS_DEVCRYPTO_BYTESPAN_H
