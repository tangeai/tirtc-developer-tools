#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "probe_send_session.h"

namespace {

constexpr uint8_t kAmrNbFt0Header = 0x04;
constexpr uint8_t kAmrNbFt7Header = 0x3C;
constexpr uint8_t kAmrNbFt8SidHeader = 0x44;
constexpr uint8_t kAmrNbPaddingBitHeader = 0xBC;

void expect(bool condition, const char* message) {
  if (!condition) {
    std::fprintf(stderr, "expect failed: %s\n", message);
    std::abort();
  }
}

std::filesystem::path make_temp_root() {
  const auto suffix = std::chrono::steady_clock::now().time_since_epoch().count();
  std::filesystem::path root = std::filesystem::temp_directory_path() /
                               ("tirtc-devtools-driver-contract-" + std::to_string(suffix));
  std::filesystem::create_directories(root);
  return root;
}

void write_bytes(const std::filesystem::path& path, const std::vector<uint8_t>& bytes) {
  std::ofstream output(path, std::ios::binary | std::ios::trunc);
  output.write(reinterpret_cast<const char*>(bytes.data()),
               static_cast<std::streamsize>(bytes.size()));
  output.close();
  expect(output.good(), "write test bytes");
}

devtools_driver_probe::PacketEntry packet(size_t size) {
  devtools_driver_probe::PacketEntry entry{};
  entry.pts_us = 0;
  entry.offset = 0;
  entry.size = size;
  return entry;
}

bool validate_amr(const std::filesystem::path& path, uint32_t sample_rate_hz, uint32_t channels,
                  size_t packet_size) {
  return devtools_driver_probe::validate_audio_packet_index(path, "amr", sample_rate_hz, channels,
                                                            {packet(packet_size)});
}

void test_amr_packet_index_validation(const std::filesystem::path& root) {
  const std::filesystem::path path = root / "audio.amr";

  std::vector<uint8_t> valid_ft7(32, 0);
  valid_ft7[0] = kAmrNbFt7Header;
  write_bytes(path, valid_ft7);
  expect(validate_amr(path, 8000, 1, valid_ft7.size()), "valid amr nb ft7 accepted");
  expect(!validate_amr(path, 16000, 1, valid_ft7.size()), "amr 16k rejected");
  expect(!validate_amr(path, 8000, 2, valid_ft7.size()), "amr stereo rejected");

  std::vector<uint8_t> invalid_ft(6, 0);
  invalid_ft[0] = kAmrNbFt8SidHeader;
  write_bytes(path, invalid_ft);
  expect(!validate_amr(path, 8000, 1, invalid_ft.size()), "amr sid ft rejected");

  std::vector<uint8_t> invalid_padding(32, 0);
  invalid_padding[0] = kAmrNbPaddingBitHeader;
  write_bytes(path, invalid_padding);
  expect(!validate_amr(path, 8000, 1, invalid_padding.size()), "amr padding bits rejected");

  std::vector<uint8_t> truncated_ft7(31, 0);
  truncated_ft7[0] = kAmrNbFt7Header;
  write_bytes(path, truncated_ft7);
  expect(!validate_amr(path, 8000, 1, truncated_ft7.size()), "amr truncated ft7 rejected");

  std::vector<uint8_t> trailing_ft0(14, 0);
  trailing_ft0[0] = kAmrNbFt0Header;
  write_bytes(path, trailing_ft0);
  expect(!validate_amr(path, 8000, 1, trailing_ft0.size()), "amr boundary mismatch rejected");
}

void test_pcm_packet_index_validation(const std::filesystem::path& root) {
  const std::filesystem::path path = root / "audio.pcm";
  write_bytes(path, std::vector<uint8_t>(8, 0));
  expect(devtools_driver_probe::validate_audio_packet_index(path, "pcm", 16000, 2, {packet(8)}),
         "aligned pcm packet accepted");
  expect(!devtools_driver_probe::validate_audio_packet_index(path, "pcm", 16000, 2, {packet(6)}),
         "misaligned pcm packet rejected");
}

}  // namespace

int main() {
  const std::filesystem::path root = make_temp_root();
  test_amr_packet_index_validation(root);
  test_pcm_packet_index_validation(root);
  std::filesystem::remove_all(root);
  return 0;
}
