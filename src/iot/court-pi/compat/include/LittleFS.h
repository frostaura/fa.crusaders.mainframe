// Crusaders Mainframe — court-pi compat: LittleFS as a directory on the SD card.
//
// The bridge's records (the last accepted answer, undelivered events, the keys,
// the network set, the event sequence mark) are written tmp-then-rename exactly
// as on the ESP. Here every write-mode close() is fsync()ed and every rename()
// fsyncs the directory, because an SD card under a power cut is the Pi's
// equivalent of a torn LittleFS block — and the sequence mark is load-bearing
// (the API dedupes on (tenant, device, seq) forever).

#ifndef CRUSADERS_COURT_PI_COMPAT_LITTLEFS_H
#define CRUSADERS_COURT_PI_COMPAT_LITTLEFS_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

enum SeekMode { SeekSet = 0, SeekCur = 1, SeekEnd = 2 };

class File {
public:
  File() = default;
  ~File();
  File(const File&) = delete;
  File& operator=(const File&) = delete;
  File(File&& other) noexcept;
  File& operator=(File&& other) noexcept;

  explicit operator bool() const { return fp_ != nullptr; }

  size_t write(const uint8_t* data, size_t len);
  size_t read(uint8_t* out, size_t len);
  size_t size() const;
  bool seek(uint32_t pos, SeekMode mode);
  void close();

private:
  friend class LittleFSClass;
  FILE* fp_ = nullptr;
  bool writing_ = false;
};

class LittleFSClass {
public:
  /// Every path is relative to COURT_BRAIN_DATA (compat::config().data).
  bool begin();
  bool format();
  File open(const char* path, const char* mode);
  bool exists(const char* path);
  bool remove(const char* path);
  bool rename(const char* from, const char* to);
  bool mkdir(const char* path);

private:
  bool full(const char* path, char* out, size_t cap) const;
};

extern LittleFSClass LittleFS;

#endif // CRUSADERS_COURT_PI_COMPAT_LITTLEFS_H
