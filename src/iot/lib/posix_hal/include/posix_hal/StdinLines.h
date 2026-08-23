// Crusaders Mainframe — a non-blocking line reader for the simulator console.
//
// Not a hal/ port: nothing on the real board has a keyboard, and inventing a
// port for one would put a shape in hal/ that no firmware implements. It lives
// here because reading stdin without blocking is platform code, and platform
// code in lib/ is what posix_hal is for.
//
// WHY NON-BLOCKING MATTERS HERE
// -----------------------------
// The same loop that reads the console runs the relay auto-off timer. A
// blocking getline() would stop that timer for as long as nobody typed, which
// would make the simulator's most important property — the court goes dark on
// schedule — depend on operator activity. That is precisely the defect the Mega
// exists to remove, so reproducing it in the simulator would be worse than
// having no console at all.
//
// Over-long lines are TRUNCATED at kMaxLine and the remainder is discarded up to
// the newline, rather than being split into two lines. A console command cut in
// half becomes a different, valid-looking command.

#ifndef CRUSADERS_POSIX_HAL_STDINLINES_H
#define CRUSADERS_POSIX_HAL_STDINLINES_H

#include <stdint.h>

namespace posix_hal {

class StdinLines {
public:
  /// Longest console line kept. A scan code is short and a command is shorter.
  static constexpr uint16_t kMaxLine = 128U;

  StdinLines();

  /// Put stdin into non-blocking mode. False when it cannot be — a piped stdin
  /// that has already closed, for instance — in which case the simulator runs
  /// without a console rather than refusing to start.
  bool begin();

  /// Read whatever has arrived. True when a complete line is in line().
  /// Call repeatedly until it returns false.
  bool poll();

  /// The last complete line, without its terminator. Never null.
  const char* line() const { return line_; }

  /// True once stdin has reached end of file, so a simulator started with a
  /// closed or exhausted stdin does not spin on it.
  bool eof() const { return eof_; }

private:
  bool takeByte(char c);

  /// Bytes read from the fd but not yet turned into lines.
  ///
  /// Needed because one read() can contain a whole line AND the start of the
  /// next: poll() returns as soon as a line is complete, so the tail has to
  /// survive until the next call or the second command is silently eaten.
  static constexpr uint16_t kChunk = 64U;

  char chunk_[kChunk];
  uint16_t chunkLen_;
  uint16_t chunkPos_;

  char buf_[kMaxLine + 1U];
  char line_[kMaxLine + 1U];
  uint16_t len_;
  bool truncating_;
  bool eof_;
};

} // namespace posix_hal

#endif // CRUSADERS_POSIX_HAL_STDINLINES_H
