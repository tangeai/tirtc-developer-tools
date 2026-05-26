#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <deque>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "tirtc/audio.h"
#include "tirtc/av.h"

namespace devtools_driver_probe {

inline constexpr int kRequestSchemaVersion = 1;
inline constexpr int kDriverSchemaVersion = 1;
inline constexpr int kExitRoleFailed = 1;
inline constexpr int kExitUsage = 2;
inline constexpr int kExitPreflight = 3;
inline constexpr uint8_t kDefaultAudioStreamId = 10;
inline constexpr uint8_t kDefaultVideoStreamId = 11;
inline constexpr int kDefaultFrameLimit = 1;
inline constexpr int kDefaultDurationMs = 0;
inline constexpr int kDefaultConnectTimeoutMs = 8000;
inline constexpr int kDefaultFirstPacketTimeoutMs = 8000;
inline constexpr int kDefaultFirstOutputTimeoutMs = 10000;
inline constexpr const char* kDriverVersion = "devtools-driver-probe-v1";
inline constexpr uint32_t kAudioBitsPerSample = 16;

extern std::atomic<int> g_stop_requested;

enum class StageResult {
  NotStarted,
  Running,
  Passed,
  Failed,
  Skipped,
};

struct StageStatus {
  StageResult status = StageResult::NotStarted;
  std::string reason_code;
  std::string started_at;
  std::string finished_at;
  std::string evidence_event_id;
};

struct PacketEntry {
  int64_t pts_us = 0;
  uint64_t offset = 0;
  size_t size = 0;
  uint32_t samples_per_channel = 0;
  bool is_key_frame = false;
};

struct RoleRequest {
  int schema_version = 0;
  std::string execution_id;
  std::string case_id;
  std::string pairing_id;
  std::string role;
  std::string endpoint;
  std::string remote_id;
  std::string device_secret_key;
  std::string token;
  bool require_audio = true;
  bool require_control_probe = true;
  std::string token_fingerprint;
  std::string bootstrap_id;
  std::string bootstrap_path;
  uint8_t audio_stream_id = kDefaultAudioStreamId;
  uint8_t video_stream_id = kDefaultVideoStreamId;
  std::string media_source_path;
  std::string video_codec = "h264";
  std::string audio_codec = "g711a";
  uint32_t audio_sample_rate_hz = 8000;
  uint32_t audio_channels = 1;
  std::string output_consumer = "frame_dump";
  int frame_limit = kDefaultFrameLimit;
  bool exit_after_first_session = false;
  int duration_ms = kDefaultDurationMs;
  int connect_timeout_ms = kDefaultConnectTimeoutMs;
  int first_packet_timeout_ms = kDefaultFirstPacketTimeoutMs;
  int first_output_timeout_ms = kDefaultFirstOutputTimeoutMs;
  std::string artifact_root;
  std::string app_id;
};

struct PendingCommandEcho {
  TirtcConn* connection = nullptr;
  int session_index = 0;
  uint32_t command = 0;
  std::vector<uint8_t> payload;
  std::string payload_hash;
};

struct DriverContext {
  RoleRequest request;
  std::string request_path;
  std::string runtime_root;
  std::string asset_root;
  std::filesystem::path artifact_root;
  std::ofstream events;
  std::mutex events_lock;
  std::ofstream log;
  std::map<std::string, StageStatus> stages;
  int event_index = 0;
  std::string bootstrap_id;
  std::string bootstrap_path;
  std::string requested_video_codec;
  std::string actual_video_codec;
  std::string media_path;
  std::string audio_asset_key;
  std::string audio_media_path;
  std::string video_media_path;
  int audio_packet_count = 0;
  uint64_t audio_bytes = 0;
  int video_packet_count = 0;
  uint64_t video_bytes = 0;
  int first_audio_output_ms = -1;
  std::string output_consumer;
  int decoded_video_frame_count = 0;
  int exit_code = 0;
  std::string status = "completed";
  std::string reason_code;
  std::string started_at;
  std::string finished_at;
  std::chrono::steady_clock::time_point monotonic_started_at{};
  int first_audio_packet_ms = -1;
  int first_video_packet_ms = -1;
  int first_key_frame_ms = -1;
  int first_decoded_frame_ms = -1;
  int first_rendered_frame_ms = -1;
  std::string log_upload_status;
  std::string log_id;
  std::string log_upload_reason_code;
  int log_upload_error_code = 0;
  std::atomic<int> command_echo_received{0};
  std::atomic<int> command_echo_echoed{0};
  std::atomic<int> command_echo_errors{0};
  mutable std::mutex command_echo_lock;
  mutable std::mutex pending_command_echoes_lock;
  std::deque<PendingCommandEcho> pending_command_echoes;
  uint32_t command_echo_last_command = 0;
  size_t command_echo_last_payload_bytes = 0;
  std::string command_echo_last_payload_hash;
  int command_echo_last_send_result = 0;
  std::atomic<int> stream_message_sent{0};
  std::atomic<int> stream_message_received{0};
  std::atomic<int> stream_message_errors{0};
  std::atomic<int> stream_message_matched_receives{0};
  mutable std::mutex stream_message_lock;
  int stream_message_last_session_index = 0;
  int64_t stream_message_last_payload_epoch_seconds = 0;
  bool stream_message_has_last_payload = false;
  size_t stream_message_last_payload_bytes = 0;
  std::string stream_message_last_payload_hash;
  int stream_message_last_send_result = 0;
  int stream_message_first_send_monotonic_ms = -1;
  int stream_message_last_send_monotonic_ms = -1;
  int stream_message_previous_send_monotonic_ms = -1;
  bool stream_message_periodic_send_ok = false;
  bool stream_message_stopped_after_disconnect = false;
};

struct ServiceContext {
  std::atomic<int> started{0};
  std::atomic<int> stopped{0};
  std::atomic<int> errors{0};
  std::mutex connections_lock;
  std::deque<TirtcConn*> accepted_connections;
};

struct ConnectionEvents {
  std::atomic<int> connected{0};
  std::atomic<int> disconnected{0};
  std::atomic<int> errors{0};
};

struct ConnCallbackContext {
  DriverContext* driver_context = nullptr;
  ConnectionEvents* connection_events = nullptr;
  int session_index = 0;
};

struct OutputEvents {
  std::atomic<int> audio_playing{0};
  std::atomic<int> rendering{0};
  std::atomic<int> failed{0};
};

struct AudioCaptureContext {
  std::atomic<int> outputs{0};
  std::filesystem::path marker_path;
  std::filesystem::path pcm_path;
  uint32_t sample_rate_hz = 0;
  uint32_t channels = 0;
  uint64_t captured_bytes = 0;
  int first_output_ms = -1;
};

struct FrameDumpContext {
  std::atomic<int> frames{0};
  std::filesystem::path render_dir;
  uint8_t stream_id = kDefaultVideoStreamId;
  int first_frame_ms = -1;
  size_t first_frame_width = 0;
  size_t first_frame_height = 0;
  std::string first_frame_pixel_format = "unknown";
  int64_t first_frame_pts_us = 0;
  uint64_t first_frame_bytes = 0;
  std::filesystem::path first_frame_raw_path;
  std::filesystem::path first_frame_metadata_path;
};

std::string now_rfc3339();
std::string json_escape(const std::string& text);
std::string read_text_file(const std::string& path);
bool write_text_file(const std::filesystem::path& path, const std::string& text);
std::string redact_request_json(const std::string& input);
bool is_safe_execution_id(const std::string& value);
int elapsed_ms_since_start(const DriverContext* context);
std::string fnv1a64_hex(const void* data, size_t length);

RoleRequest parse_request(const std::string& request_json);
TirtcMediaCodec codec_to_runtime_codec(const std::string& codec);
TirtcVideoBitstreamFormat codec_to_bitstream_format(const std::string& codec);
std::filesystem::path codec_media_path(const std::string& asset_root, const std::string& codec);
std::filesystem::path codec_packets_path(const std::string& asset_root, const std::string& codec);
TirtcMediaCodec audio_codec_to_runtime_codec(const std::string& codec);
std::string audio_track_key(const std::string& codec, uint32_t sample_rate_hz, uint32_t channels);
std::filesystem::path audio_media_path(const std::string& asset_root, const std::string& codec,
                                       uint32_t sample_rate_hz, uint32_t channels);
std::filesystem::path audio_packets_path(const std::string& asset_root, const std::string& codec,
                                         uint32_t sample_rate_hz, uint32_t channels);
std::vector<PacketEntry> read_packets(const std::filesystem::path& path, int limit);
std::vector<PacketEntry> read_audio_packets(const std::filesystem::path& path, int limit);
std::vector<uint8_t> read_packet_bytes(const std::filesystem::path& path,
                                       const PacketEntry& packet);

void init_stages(DriverContext* context);
std::string emit_event(DriverContext* context, const std::string& level, const std::string& family,
                       const std::string& kind, const std::string& payload);
void start_stage(DriverContext* context, const std::string& stage);
void finish_stage(DriverContext* context, const std::string& stage, StageResult result,
                  const std::string& reason_code, const std::string& evidence_event_id);
bool validate_preflight(DriverContext* context, const std::string& request_json,
                        std::string* out_reason);
bool upload_logs_on_failure(DriverContext* context);
bool write_summary(DriverContext* context);

void on_signal(int);
bool run_send_role(DriverContext* context);
bool run_receive_role(DriverContext* context);

}  // namespace devtools_driver_probe
