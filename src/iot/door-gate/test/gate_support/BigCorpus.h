// A corpus file loader for the gate's suites whose families outgrow the shared
// reader's 64 KiB bound (compat/cases.json is about 200 KiB). The shared
// `corpus::File` is the court-box lane's and keeps its interface; this one
// reads the same tree the same way (walking up from wherever `pio test` runs
// the binary) into a static buffer large enough for any family, and hands back
// a root every `corpus::` parsing helper accepts unchanged.
#ifndef CRUSADERS_GATE_TEST_BIGCORPUS_H
#define CRUSADERS_GATE_TEST_BIGCORPUS_H

#include <stddef.h>
#include <stdio.h>

namespace gatetest {

constexpr size_t kBigCorpusMax = 1048576U;

class BigFile {
public:
  bool load(const char* family, const char* fileName) {
    loaded_ = false;
    char path[512];
    for (int up = 0; up <= 8 && !loaded_; ++up) {
      size_t at = 0U;
      for (int i = 0; i < up; ++i) {
        at += static_cast<size_t>(snprintf(path + at, sizeof(path) - at, "../"));
      }
      snprintf(path + at, sizeof(path) - at, "src/contracts/device-protocol/%s/%s", family, fileName);
      FILE* f = fopen(path, "rb");
      if (f == nullptr) {
        continue;
      }
      const size_t read = fread(buffer_, 1U, sizeof(buffer_) - 1U, f);
      const bool overflowed = read == sizeof(buffer_) - 1U;
      fclose(f);
      if (!overflowed) {
        buffer_[read] = '\0';
        loaded_ = true;
      }
    }
    return loaded_;
  }

  const char* root() const { return loaded_ ? buffer_ : nullptr; }

private:
  char buffer_[kBigCorpusMax];
  bool loaded_ = false;
};

} // namespace gatetest

#endif // CRUSADERS_GATE_TEST_BIGCORPUS_H
