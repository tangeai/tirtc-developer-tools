#include "probe_common.h"

#include <cctype>
#include <chrono>
#include <ctime>
#include <exception>
#include <iomanip>
#include <optional>
#include <regex>
#include <sstream>

namespace devtools_driver_probe {
namespace {

std::optional<std::string> find_object(const std::string& text, const std::string& key) {
  const std::regex key_regex("\"" + key + "\"\\s*:");
  std::smatch match;
  if (!std::regex_search(text, match, key_regex)) {
    return std::nullopt;
  }
  size_t pos = static_cast<size_t>(match.position() + match.length());
  while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) {
    ++pos;
  }
  if (pos >= text.size() || text[pos] != '{') {
    return std::nullopt;
  }

  int depth = 0;
  bool in_string = false;
  bool escaped = false;
  const size_t start = pos;
  for (; pos < text.size(); ++pos) {
    const char ch = text[pos];
    if (in_string) {
      if (escaped) {
        escaped = false;
      } else if (ch == '\\') {
        escaped = true;
      } else if (ch == '"') {
        in_string = false;
      }
      continue;
    }
    if (ch == '"') {
      in_string = true;
    } else if (ch == '{') {
      ++depth;
    } else if (ch == '}') {
      --depth;
      if (depth == 0) {
        return text.substr(start, pos - start + 1);
      }
    }
  }
  return std::nullopt;
}

std::optional<std::string> get_string_value(const std::string& text, const std::string& key) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*\"((?:\\\\.|[^\"])*)\"");
  std::smatch match;
  if (!std::regex_search(text, match, pattern)) {
    return std::nullopt;
  }
  return match[1].str();
}

std::optional<int> get_int_value(const std::string& text, const std::string& key) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*(-?[0-9]+)");
  std::smatch match;
  if (!std::regex_search(text, match, pattern)) {
    return std::nullopt;
  }
  return std::stoi(match[1].str());
}

std::optional<bool> get_bool_value(const std::string& text, const std::string& key) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*(true|false|0|1)");
  std::smatch match;
  if (!std::regex_search(text, match, pattern)) {
    return std::nullopt;
  }
  return match[1].str() == "true" || match[1].str() == "1";
}

std::string fallback_string(std::string value, const std::string& fallback) {
  return value.empty() ? fallback : value;
}

std::string get_path_string(const std::string& text, const std::vector<std::string>& path) {
  std::string current = text;
  for (size_t index = 0; index + 1 < path.size(); ++index) {
    auto object = find_object(current, path[index]);
    if (!object.has_value()) {
      return "";
    }
    current = *object;
  }
  auto value = get_string_value(current, path.back());
  return value.value_or("");
}

int get_path_int(const std::string& text, const std::vector<std::string>& path, int fallback) {
  std::string current = text;
  for (size_t index = 0; index + 1 < path.size(); ++index) {
    auto object = find_object(current, path[index]);
    if (!object.has_value()) {
      return fallback;
    }
    current = *object;
  }
  auto value = get_int_value(current, path.back());
  return value.value_or(fallback);
}

bool get_path_bool(const std::string& text, const std::vector<std::string>& path, bool fallback) {
  std::string current = text;
  for (size_t index = 0; index + 1 < path.size(); ++index) {
    auto object = find_object(current, path[index]);
    if (!object.has_value()) {
      return fallback;
    }
    current = *object;
  }
  auto value = get_bool_value(current, path.back());
  return value.value_or(fallback);
}

std::string video_media_filename(const std::string& codec) {
  if (codec == "h265") {
    return "video_send.h265";
  }
  if (codec == "mjpeg") {
    return "video_send.mjpeg";
  }
  return "video_send.h264";
}

std::string audio_media_extension(const std::string& codec) {
  if (codec == "pcm") {
    return ".pcm";
  }
  if (codec == "aac") {
    return ".aac";
  }
  if (codec == "opus") {
    return ".opus";
  }
  if (codec == "amr") {
    return ".amr";
  }
  return ".g711a";
}

std::string fixed_audio_media_filename(const std::string& codec, uint32_t sample_rate_hz,
                                       uint32_t channels) {
  return "audio_send." + audio_track_key(codec, sample_rate_hz, channels) +
         audio_media_extension(codec);
}

}  // namespace

std::string now_rfc3339() {
  const auto now = std::chrono::system_clock::now();
  const std::time_t raw = std::chrono::system_clock::to_time_t(now);
  std::tm tm{};
  gmtime_r(&raw, &tm);
  std::ostringstream out;
  out << std::put_time(&tm, "%Y-%m-%dT%H:%M:%SZ");
  return out.str();
}

std::string json_escape(const std::string& text) {
  std::string out;
  for (const char ch : text) {
    switch (ch) {
      case '\\':
        out += "\\\\";
        break;
      case '"':
        out += "\\\"";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        out.push_back(ch);
        break;
    }
  }
  return out;
}

std::string read_text_file(const std::string& path) {
  std::ifstream input(path);
  std::ostringstream buffer;
  buffer << input.rdbuf();
  return buffer.str();
}

bool write_text_file(const std::filesystem::path& path, const std::string& text) {
  const std::filesystem::path parent_path = path.parent_path();
  std::error_code error;
  if (!parent_path.empty()) {
    std::filesystem::create_directories(parent_path, error);
    if (error) {
      return false;
    }
  }

  const auto suffix = std::chrono::steady_clock::now().time_since_epoch().count();
  const std::filesystem::path temp_path =
      path.parent_path() / (path.filename().string() + ".tmp." + std::to_string(suffix));

  std::ofstream output(temp_path, std::ios::out | std::ios::trunc);
  if (!output.is_open()) {
    return false;
  }
  output << text;
  output.close();
  if (!output.good()) {
    std::filesystem::remove(temp_path, error);
    return false;
  }

  std::filesystem::rename(temp_path, path, error);
  if (error) {
    error.clear();
    std::filesystem::remove(path, error);
    error.clear();
    std::filesystem::rename(temp_path, path, error);
    if (error) {
      std::filesystem::remove(temp_path, error);
      return false;
    }
  }
  return true;
}

std::string redact_request_json(const std::string& input) {
  std::string output = std::regex_replace(
      input,
      std::regex(
          "(\"(?:token|client_token|device_secret_key|secret_key|license)\"\\s*:\\s*\")[^\"]*(\")"),
      "$1[REDACTED]$2");
  return output;
}

bool is_safe_execution_id(const std::string& value) {
  if (value.empty()) {
    return false;
  }
  for (const char ch : value) {
    if (!(std::isalnum(static_cast<unsigned char>(ch)) || ch == '.' || ch == '_' || ch == '-')) {
      return false;
    }
  }
  return true;
}

int elapsed_ms_since_start(const DriverContext* context) {
  if (context == nullptr ||
      context->monotonic_started_at == std::chrono::steady_clock::time_point{}) {
    return 0;
  }
  const auto elapsed = std::chrono::steady_clock::now() - context->monotonic_started_at;
  const auto elapsed_ms = std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count();
  return elapsed_ms < 0 ? 0 : static_cast<int>(elapsed_ms);
}

RoleRequest parse_request(const std::string& request_json) {
  RoleRequest request{};
  request.schema_version = get_int_value(request_json, "schema_version").value_or(0);
  request.execution_id = get_string_value(request_json, "execution_id").value_or("");
  request.case_id = get_string_value(request_json, "case_id").value_or("");
  request.pairing_id = get_string_value(request_json, "pairing_id").value_or("");
  if (request.pairing_id.empty()) {
    request.pairing_id = get_path_string(request_json, {"validation", "pairing_id"});
  }
  if (request.pairing_id.empty()) {
    request.pairing_id = request.execution_id;
  }
  request.role = get_string_value(request_json, "role").value_or("");
  request.cache_dir = get_string_value(request_json, "cache_dir").value_or("");
  request.role_dir = get_string_value(request_json, "role_dir").value_or("");
  request.input_mode = get_string_value(request_json, "input_mode").value_or("");
  request.output_mode = fallback_string(get_string_value(request_json, "output_mode").value_or(""),
                                        get_path_string(request_json, {"output", "mode"}));
  if (request.output_mode.empty()) {
    request.output_mode = "file";
  }
  request.pairing_mode =
      fallback_string(get_string_value(request_json, "pairing_mode").value_or(""), "standard");

  request.endpoint = get_string_value(request_json, "endpoint").value_or("");
  request.endpoint_mode =
      fallback_string(get_string_value(request_json, "endpoint_mode").value_or(""),
                      request.endpoint.empty() ? "default" : "custom");
  request.remote_id = get_path_string(request_json, {"identity", "device_id"});
  if (request.remote_id.empty()) {
    request.remote_id = get_path_string(request_json, {"identity", "remote_id"});
  }
  request.device_secret_key = get_path_string(request_json, {"identity", "device_secret_key"});
  request.token = get_path_string(request_json, {"identity", "token"});
  request.require_audio = get_bool_value(request_json, "require_audio").value_or(true);
  request.require_control_probe =
      get_bool_value(request_json, "require_control_probe").value_or(true);
  if (request.token.empty()) {
    request.token = get_path_string(request_json, {"bootstrap", "client_token"});
  }
  request.token_fingerprint = get_path_string(request_json, {"bootstrap", "token_fingerprint"});
  request.bootstrap_id = get_path_string(request_json, {"identity", "bootstrap_id"});
  request.bootstrap_path = get_path_string(request_json, {"identity", "bootstrap_path"});
  if (!request.bootstrap_path.empty()) {
    const std::string bootstrap_json = read_text_file(request.bootstrap_path);
    if (!bootstrap_json.empty()) {
      request.require_control_probe = get_bool_value(bootstrap_json, "require_control_probe")
                                          .value_or(request.require_control_probe);
    }
  }
  request.audio_stream_id = static_cast<uint8_t>(
      get_path_int(request_json, {"streams", "audio_stream_id"}, kDefaultAudioStreamId));
  request.video_stream_id = static_cast<uint8_t>(
      get_path_int(request_json, {"streams", "video_stream_id"}, kDefaultVideoStreamId));
  request.receive_audio_enabled =
      get_path_bool(request_json, {"media", "receive_audio", "enabled"}, false);
  request.receive_audio_stream_id = get_path_int(
      request_json, {"media", "receive_audio", "stream_id"}, kDefaultReceiveAudioStreamId);
  request.media_source_path = get_path_string(request_json, {"media", "source", "path"});
  request.media_input_path = get_path_string(request_json, {"media", "media_input_path"});
  request.video_codec = get_path_string(request_json, {"media", "video", "codec"});
  if (request.video_codec.empty()) {
    request.video_codec = "h264";
  }
  request.audio_codec = get_path_string(request_json, {"media", "audio", "codec"});
  if (request.audio_codec.empty()) {
    request.audio_codec = "g711a";
  }
  request.audio_sample_rate_hz =
      static_cast<uint32_t>(get_path_int(request_json, {"media", "audio", "sample_rate_hz"}, 8000));
  request.audio_channels =
      static_cast<uint32_t>(get_path_int(request_json, {"media", "audio", "channels"}, 1));
  request.output_consumer = get_path_string(request_json, {"output", "consumer"});
  if (request.output_consumer.empty()) {
    request.output_consumer = "frame_dump";
  }
  request.audio_input_processing_status =
      get_path_string(request_json, {"audio_processing", "input", "status"});
  if (request.audio_input_processing_status.empty()) {
    request.audio_input_processing_status = "not_requested";
  }
  request.audio_input_aec =
      fallback_string(get_path_string(request_json, {"audio_processing", "input", "requested", "aec"}),
                      "disabled");
  request.audio_input_agc =
      fallback_string(get_path_string(request_json, {"audio_processing", "input", "requested", "agc"}),
                      "disabled");
  request.audio_input_ans =
      fallback_string(get_path_string(request_json, {"audio_processing", "input", "requested", "ans"}),
                      "disabled");
  request.audio_input_aec_mode =
      get_path_int(request_json, {"audio_processing", "input", "runtime", "aec_mode"}, 0);
  request.audio_input_agc_level =
      get_path_int(request_json, {"audio_processing", "input", "runtime", "agc_level"}, 0);
  request.audio_input_ans_level =
      get_path_int(request_json, {"audio_processing", "input", "runtime", "ans_level"}, 0);
  request.audio_output_processing_status =
      get_path_string(request_json, {"audio_processing", "output", "status"});
  if (request.audio_output_processing_status.empty()) {
    request.audio_output_processing_status = "not_requested";
  }
  request.audio_output_agc =
      fallback_string(get_path_string(request_json, {"audio_processing", "output", "requested", "agc"}),
                      "disabled");
  request.audio_output_ans =
      fallback_string(get_path_string(request_json, {"audio_processing", "output", "requested", "ans"}),
                      "disabled");
  request.audio_output_agc_level =
      get_path_int(request_json, {"audio_processing", "output", "runtime", "agc_level"}, 0);
  request.audio_output_ans_level =
      get_path_int(request_json, {"audio_processing", "output", "runtime", "ans_level"}, 0);
  request.preview_requested = get_path_bool(request_json, {"preview", "requested"}, false);
  request.frame_limit =
      get_path_int(request_json, {"output", "video", "frame_limit"}, kDefaultFrameLimit);
  request.exit_after_first_session =
      get_path_bool(request_json, {"run", "exit_after_first_session"}, false);
  request.duration_ms = get_path_int(request_json, {"run", "duration_ms"}, kDefaultDurationMs);
  request.connect_timeout_ms =
      get_path_int(request_json, {"run", "connect_timeout_ms"}, kDefaultConnectTimeoutMs);
  request.first_packet_timeout_ms =
      get_path_int(request_json, {"run", "first_packet_timeout_ms"}, kDefaultFirstPacketTimeoutMs);
  request.first_output_timeout_ms =
      get_path_int(request_json, {"run", "first_output_timeout_ms"}, kDefaultFirstOutputTimeoutMs);
  request.artifact_root = get_path_string(request_json, {"artifact", "root_dir"});
  request.app_id = get_path_string(request_json, {"probe", "app_id"});
  return request;
}

TirtcMediaCodec codec_to_runtime_codec(const std::string& codec) {
  if (codec == "h265") {
    return TIRTC_MEDIA_CODEC_VIDEO_H265;
  }
  if (codec == "mjpeg") {
    return TIRTC_MEDIA_CODEC_VIDEO_MJPEG;
  }
  return TIRTC_MEDIA_CODEC_VIDEO_H264;
}

TirtcVideoBitstreamFormat codec_to_bitstream_format(const std::string& codec) {
  if (codec == "h265") {
    return TIRTC_VIDEO_BITSTREAM_FORMAT_H265_ANNEXB;
  }
  if (codec == "mjpeg") {
    return TIRTC_VIDEO_BITSTREAM_FORMAT_MJPEG_JFIF;
  }
  return TIRTC_VIDEO_BITSTREAM_FORMAT_H264_ANNEXB;
}

std::filesystem::path codec_media_path(const std::string& asset_root, const std::string& codec) {
  if (asset_root_uses_fixed_cache(asset_root)) {
    return std::filesystem::path(asset_root) / video_media_filename(codec);
  }
  if (codec == "h265") {
    return std::filesystem::path(asset_root) / "video" / "video.h265";
  }
  if (codec == "mjpeg") {
    return std::filesystem::path(asset_root) / "video" / "video.mjpeg";
  }
  return std::filesystem::path(asset_root) / "video" / "video.h264";
}

std::filesystem::path codec_packets_path(const std::string& asset_root, const std::string& codec) {
  if (asset_root_uses_fixed_cache(asset_root)) {
    return std::filesystem::path(asset_root) / (video_media_filename(codec) + ".packets.csv");
  }
  if (codec == "h265") {
    return std::filesystem::path(asset_root) / "video" / "video_h265_packets.csv";
  }
  if (codec == "mjpeg") {
    return std::filesystem::path(asset_root) / "video" / "video_mjpeg_packets.csv";
  }
  return std::filesystem::path(asset_root) / "video" / "video_packets.csv";
}

bool asset_root_uses_fixed_cache(const std::string& asset_root) {
  return std::filesystem::exists(std::filesystem::path(asset_root) / "media_input.json");
}

TirtcMediaCodec audio_codec_to_runtime_codec(const std::string& codec) {
  if (codec == "pcm") {
    return TIRTC_MEDIA_CODEC_AUDIO_PCM;
  }
  if (codec == "aac") {
    return TIRTC_MEDIA_CODEC_AUDIO_AAC;
  }
  if (codec == "opus") {
    return TIRTC_MEDIA_CODEC_AUDIO_OPUS;
  }
  if (codec == "amr") {
    return TIRTC_MEDIA_CODEC_AUDIO_AMR;
  }
  return TIRTC_MEDIA_CODEC_AUDIO_G711A;
}

std::string audio_track_key(const std::string& codec, uint32_t sample_rate_hz, uint32_t channels) {
  return codec + "_" + std::to_string(sample_rate_hz) + "_" + std::to_string(channels) + "ch_s16";
}

std::filesystem::path audio_media_path(const std::string& asset_root, const std::string& codec,
                                       uint32_t sample_rate_hz, uint32_t channels) {
  if (asset_root_uses_fixed_cache(asset_root)) {
    return std::filesystem::path(asset_root) /
           fixed_audio_media_filename(codec, sample_rate_hz, channels);
  }
  return std::filesystem::path(asset_root) / "audio" /
         (audio_track_key(codec, sample_rate_hz, channels) + audio_media_extension(codec));
}

std::filesystem::path audio_packets_path(const std::string& asset_root, const std::string& codec,
                                         uint32_t sample_rate_hz, uint32_t channels) {
  if (asset_root_uses_fixed_cache(asset_root)) {
    return std::filesystem::path(asset_root) /
           (fixed_audio_media_filename(codec, sample_rate_hz, channels) + ".packets.csv");
  }
  return std::filesystem::path(asset_root) / "audio" /
         (audio_track_key(codec, sample_rate_hz, channels) + ".csv");
}

std::vector<PacketEntry> read_packets(const std::filesystem::path& path, int limit) {
  std::ifstream input(path);
  std::vector<PacketEntry> packets;
  std::string line;
  std::getline(input, line);
  while ((limit <= 0 || static_cast<int>(packets.size()) < limit) && std::getline(input, line)) {
    std::stringstream stream(line);
    std::string value;
    PacketEntry packet{};
    std::getline(stream, value, ',');
    packet.pts_us = std::stoll(value);
    std::getline(stream, value, ',');
    packet.offset = static_cast<uint64_t>(std::stoull(value));
    std::getline(stream, value, ',');
    packet.size = static_cast<size_t>(std::stoull(value));
    packet.is_key_frame = false;
    if (std::getline(stream, value, ',')) {
      packet.is_key_frame = value == "1";
    }
    packets.push_back(packet);
  }
  return packets;
}

std::vector<PacketEntry> read_audio_packets(const std::filesystem::path& path, int limit) {
  std::ifstream input(path);
  std::vector<PacketEntry> packets;
  std::string line;
  if (!std::getline(input, line) || line != "pts_us,offset,size") {
    return packets;
  }
  try {
    while ((limit <= 0 || static_cast<int>(packets.size()) < limit) && std::getline(input, line)) {
      std::stringstream stream(line);
      std::string value;
      PacketEntry packet{};
      std::getline(stream, value, ',');
      packet.pts_us = std::stoll(value);
      std::getline(stream, value, ',');
      packet.offset = static_cast<uint64_t>(std::stoull(value));
      std::getline(stream, value, ',');
      packet.size = static_cast<size_t>(std::stoull(value));
      if (std::getline(stream, value, ',') || packet.size == 0) {
        packets.clear();
        return packets;
      }
      packets.push_back(packet);
    }
  } catch (const std::exception&) {
    packets.clear();
  }
  return packets;
}

std::vector<uint8_t> read_packet_bytes(const std::filesystem::path& path,
                                       const PacketEntry& packet) {
  std::ifstream input(path, std::ios::binary);
  std::vector<uint8_t> bytes(packet.size);
  input.seekg(static_cast<std::streamoff>(packet.offset));
  input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
  if (static_cast<size_t>(input.gcount()) != bytes.size()) {
    bytes.clear();
  }
  return bytes;
}

}  // namespace devtools_driver_probe
