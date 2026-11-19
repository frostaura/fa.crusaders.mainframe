// court-pi compat — LittleFS as a directory, with fsync where it matters.
#include "LittleFS.h"

#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "compat/BrainConfig.h"
#include "linux_hal/Service.h"

LittleFSClass LittleFS;

namespace {

void fsyncDirOf(const char* path) {
  char copy[256];
  snprintf(copy, sizeof(copy), "%s", path);
  const int fd = ::open(dirname(copy), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (fd >= 0) {
    static_cast<void>(::fsync(fd));
    ::close(fd);
  }
}

} // namespace

File::~File() {
  close();
}

File::File(File&& other) noexcept : fp_(other.fp_), writing_(other.writing_) {
  other.fp_ = nullptr;
}

File& File::operator=(File&& other) noexcept {
  if (this != &other) {
    close();
    fp_ = other.fp_;
    writing_ = other.writing_;
    other.fp_ = nullptr;
  }
  return *this;
}

size_t File::write(const uint8_t* data, size_t len) {
  return fp_ == nullptr || data == nullptr ? 0U : fwrite(data, 1U, len, fp_);
}

size_t File::read(uint8_t* out, size_t len) {
  return fp_ == nullptr || out == nullptr ? 0U : fread(out, 1U, len, fp_);
}

size_t File::size() const {
  if (fp_ == nullptr) {
    return 0U;
  }
  struct stat st;
  if (fstat(fileno(fp_), &st) != 0) {
    return 0U;
  }
  return static_cast<size_t>(st.st_size);
}

bool File::seek(uint32_t pos, SeekMode mode) {
  if (fp_ == nullptr) {
    return false;
  }
  const int whence = mode == SeekSet ? SEEK_SET : (mode == SeekCur ? SEEK_CUR : SEEK_END);
  return fseek(fp_, static_cast<long>(pos), whence) == 0;
}

void File::close() {
  if (fp_ == nullptr) {
    return;
  }
  if (writing_) {
    static_cast<void>(fflush(fp_));
    static_cast<void>(::fsync(fileno(fp_)));
  }
  fclose(fp_);
  fp_ = nullptr;
}

bool LittleFSClass::full(const char* path, char* out, size_t cap) const {
  if (path == nullptr || strstr(path, "..") != nullptr) {
    return false;
  }
  const int n = snprintf(out, cap, "%s%s%s", compat::config().data, path[0] == '/' ? "" : "/", path);
  return n > 0 && static_cast<size_t>(n) < cap;
}

bool LittleFSClass::begin() {
  return linux_hal::ensureDir(compat::config().data);
}

bool LittleFSClass::format() {
  return begin(); // never wipes the card: the records survive whatever asked
}

File LittleFSClass::open(const char* path, const char* mode) {
  File f;
  char p[256];
  if (!full(path, p, sizeof(p)) || mode == nullptr) {
    return f;
  }
  const bool writing = mode[0] == 'w' || mode[0] == 'a';
  f.fp_ = fopen(p, writing ? (mode[0] == 'a' ? "ab" : "wb") : "rb");
  f.writing_ = writing;
  return f;
}

bool LittleFSClass::exists(const char* path) {
  char p[256];
  return full(path, p, sizeof(p)) && ::access(p, F_OK) == 0;
}

bool LittleFSClass::remove(const char* path) {
  char p[256];
  if (!full(path, p, sizeof(p)) || ::unlink(p) != 0) {
    return false;
  }
  fsyncDirOf(p);
  return true;
}

bool LittleFSClass::rename(const char* from, const char* to) {
  char a[256];
  char b[256];
  if (!full(from, a, sizeof(a)) || !full(to, b, sizeof(b)) || ::rename(a, b) != 0) {
    return false;
  }
  fsyncDirOf(b);
  return true;
}

bool LittleFSClass::mkdir(const char* path) {
  char p[256];
  return full(path, p, sizeof(p)) && (::mkdir(p, 0755) == 0 || errno == EEXIST);
}
