// The console line reader. See include/posix_hal/StdinLines.h.

#include "posix_hal/StdinLines.h"

#include <errno.h>
#include <fcntl.h>
#include <unistd.h>

namespace posix_hal {

StdinLines::StdinLines()
    : chunk_(), chunkLen_(0U), chunkPos_(0U), buf_(), line_(), len_(0U), truncating_(false), eof_(false) {
  buf_[0] = '\0';
  line_[0] = '\0';
}

bool StdinLines::begin() {
  const int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
  if (flags < 0) {
    eof_ = true;
    return false;
  }
  return fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK) == 0;
}

bool StdinLines::takeByte(char c) {
  if (c == '\n' || c == '\r') {
    const bool complete = !truncating_ && len_ > 0U;
    if (complete) {
      buf_[len_] = '\0';
      for (uint16_t i = 0U; i <= len_; ++i) {
        line_[i] = buf_[i];
      }
    }
    // A blank line is not a command, and a truncated one is not the command
    // that was typed. Both reset and report nothing.
    len_ = 0U;
    truncating_ = false;
    return complete;
  }
  if (len_ >= kMaxLine) {
    // Truncate and swallow the rest of the line. Splitting it would turn one
    // over-long command into two shorter ones that both look valid.
    truncating_ = true;
    return false;
  }
  buf_[len_] = c;
  ++len_;
  return false;
}

bool StdinLines::poll() {
  if (eof_) {
    return false;
  }
  for (;;) {
    while (chunkPos_ < chunkLen_) {
      const char c = chunk_[chunkPos_];
      ++chunkPos_;
      if (takeByte(c)) {
        return true;
      }
    }
    const ssize_t got = ::read(STDIN_FILENO, chunk_, kChunk);
    if (got == 0) {
      eof_ = true;
      return false;
    }
    if (got < 0) {
      if (errno != EAGAIN && errno != EWOULDBLOCK) {
        eof_ = true;
      }
      return false;
    }
    chunkLen_ = static_cast<uint16_t>(got);
    chunkPos_ = 0U;
  }
}

} // namespace posix_hal
