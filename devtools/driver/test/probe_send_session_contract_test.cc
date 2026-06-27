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

void test_fixed_cache_media_paths(const std::filesystem::path& root) {
  const std::filesystem::path input_root = root / "input";
  std::filesystem::create_directories(input_root);
  std::ofstream(input_root / "media_input.json", std::ios::trunc) << "{\"schema_version\":1}\n";
  expect(devtools_driver_probe::asset_root_uses_fixed_cache(input_root.string()),
         "fixed cache media_input.json detected");
  expect(devtools_driver_probe::codec_media_path(input_root.string(), "h265") ==
             input_root / "video_send.h265",
         "fixed cache h265 media path");
  expect(devtools_driver_probe::codec_packets_path(input_root.string(), "mjpeg") ==
             input_root / "video_send.mjpeg.packets.csv",
         "fixed cache mjpeg packet path");
  expect(devtools_driver_probe::audio_media_path(input_root.string(), "g711a", 16000, 1) ==
             input_root / "audio_send.g711a",
         "fixed cache g711a media path");
  expect(devtools_driver_probe::audio_packets_path(input_root.string(), "aac", 16000, 1) ==
             input_root / "audio_send.aac.packets.csv",
         "fixed cache aac packet path");
}

void test_system_av_io_request_parse() {
  const std::string request_json = R"json({
    "schema_version": 1,
    "execution_id": "cli-client-contract",
    "pairing_id": "pairing-1",
    "role": "client",
    "cache_dir": "/tmp/tirtc-cache",
    "role_dir": "/tmp/tirtc-cache/client",
    "input_mode": null,
    "output_mode": "both",
    "pairing_mode": "standard",
    "endpoint_mode": "default",
    "identity": {
      "device_id": "device-a",
      "token": "token-a",
      "bootstrap_path": "/tmp/tirtc-cache/device/bootstrap.json",
      "bootstrap_id": "bootstrap-a"
    },
    "media": {
      "media_input_path": "/tmp/tirtc-cache/input/media_input.json",
      "video": {"codec": "mjpeg"},
      "audio": {"codec": "aac", "sample_rate_hz": 16000, "channels": 1}
    },
    "output": {"mode": "both", "consumer": "packet_dump", "video": {"frame_limit": 2}},
    "audio_processing": {
      "input": {
        "status": "not_requested",
        "requested": {"aec": "disabled", "agc": "disabled", "ans": "disabled"},
        "runtime": {"aec_mode": 0, "agc_level": 0, "ans_level": 0}
      },
      "output": {
        "status": "applied",
        "requested": {"agc": "medium", "ans": "high"},
        "runtime": {"agc_level": 2, "ans_level": 3}
      }
    },
    "preview": {"requested": false}
  })json";
  const devtools_driver_probe::RoleRequest request =
      devtools_driver_probe::parse_request(request_json);
  expect(request.cache_dir == "/tmp/tirtc-cache", "cache_dir parsed");
  expect(request.role_dir == "/tmp/tirtc-cache/client", "role_dir parsed");
  expect(request.output_mode == "both", "output_mode parsed");
  expect(request.output_consumer == "packet_dump", "output consumer parsed");
  expect(request.media_input_path == "/tmp/tirtc-cache/input/media_input.json",
         "media_input_path parsed");
  expect(request.video_codec == "mjpeg", "video codec parsed");
  expect(request.audio_codec == "aac", "audio codec parsed");
  expect(request.audio_sample_rate_hz == 16000, "audio sample rate parsed");
  expect(request.audio_output_processing_status == "applied", "audio output status parsed");
  expect(request.audio_output_agc == "medium", "audio output agc parsed");
  expect(request.audio_output_ans == "high", "audio output ans parsed");
  expect(request.audio_output_agc_level == 2, "audio output agc runtime parsed");
  expect(request.audio_output_ans_level == 3, "audio output ans runtime parsed");
}

void test_system_device_receive_audio_request_parse() {
  const std::string request_json = R"json({
    "schema_version": 1,
    "execution_id": "cli-device-contract",
    "pairing_id": "pairing-1",
    "role": "device",
    "cache_dir": "/tmp/tirtc-cache",
    "role_dir": "/tmp/tirtc-cache/device",
    "input_mode": "system",
    "output_mode": "both",
    "pairing_mode": "standard",
    "endpoint_mode": "default",
    "identity": {
      "device_id": "device-a",
      "device_secret_key": "secret-a"
    },
    "media": {
      "source": {"kind": "system", "path": "/tmp/tirtc-cache/input"},
      "video": {"codec": "h264"},
      "audio": {"codec": "g711a", "sample_rate_hz": 16000, "channels": 1},
      "receive_audio": {"enabled": true, "stream_id": 14}
    },
    "output": {"mode": "both", "consumer": "packet_dump", "video": {"frame_limit": 1}},
    "preview": {"requested": true}
  })json";
  const devtools_driver_probe::RoleRequest request =
      devtools_driver_probe::parse_request(request_json);
  expect(request.role == "device", "device role parsed");
  expect(request.input_mode == "system", "system input parsed");
  expect(request.output_mode == "both", "device output mode parsed");
  expect(request.receive_audio_enabled, "device receive audio enabled parsed");
  expect(request.receive_audio_stream_id == 14, "device receive audio stream parsed");
  expect(request.preview_requested, "preview request parsed");
}

}  // namespace

int main() {
  const std::filesystem::path root = make_temp_root();
  test_amr_packet_index_validation(root);
  test_pcm_packet_index_validation(root);
  test_fixed_cache_media_paths(root);
  test_system_av_io_request_parse();
  test_system_device_receive_audio_request_parse();
  std::filesystem::remove_all(root);
  return 0;
}
