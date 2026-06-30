#include <mutex>
#include <sstream>
#include <system_error>

#include "probe_common.h"
#include "tirtc/logging.h"

namespace devtools_driver_probe {
namespace {

std::string stage_status_to_string(StageResult status) {
  switch (status) {
    case StageResult::Running:
      return "running";
    case StageResult::Passed:
      return "passed";
    case StageResult::Failed:
      return "failed";
    case StageResult::Skipped:
      return "skipped";
    case StageResult::NotStarted:
    default:
      return "not_started";
  }
}

std::string stage_summary_json(const DriverContext& context) {
  std::ostringstream out;
  out << "{";
  bool first = true;
  for (const auto& entry : context.stages) {
    if (!first) {
      out << ",";
    }
    first = false;
    out << "\n    \"" << entry.first << "\": {\"status\":\""
        << stage_status_to_string(entry.second.status) << "\"";
    if (!entry.second.reason_code.empty()) {
      out << ",\"reason_code\":\"" << json_escape(entry.second.reason_code) << "\"";
    }
    if (!entry.second.started_at.empty()) {
      out << ",\"started_at\":\"" << entry.second.started_at << "\"";
    }
    if (!entry.second.finished_at.empty()) {
      out << ",\"finished_at\":\"" << entry.second.finished_at << "\"";
    }
    if (!entry.second.evidence_event_id.empty()) {
      out << ",\"evidence_event_id\":\"" << entry.second.evidence_event_id << "\"";
    }
    out << "}";
  }
  out << "\n  }";
  return out.str();
}

std::string command_echo_summary_json(const DriverContext& context) {
  std::lock_guard<std::mutex> guard(context.command_echo_lock);
  std::ostringstream out;
  out << "{"
      << "\"enabled\":true"
      << ",\"received_count\":" << context.command_echo_received.load()
      << ",\"echoed_count\":" << context.command_echo_echoed.load()
      << ",\"error_count\":" << context.command_echo_errors.load()
      << ",\"last_command_id\":" << context.command_echo_last_command
      << ",\"last_payload_bytes\":" << context.command_echo_last_payload_bytes
      << ",\"last_payload_hash\":\"" << json_escape(context.command_echo_last_payload_hash) << "\""
      << ",\"last_send_result\":" << context.command_echo_last_send_result << "}";
  return out.str();
}

std::string stream_message_summary_json(const DriverContext& context) {
  std::lock_guard<std::mutex> guard(context.stream_message_lock);
  const bool has_last_payload = context.stream_message_has_last_payload;
  std::ostringstream out;
  out << "{"
      << "\"enabled\":true"
      << ",\"required\":" << (context.request.require_control_probe ? "true" : "false")
      << ",\"pairing_id\":\"" << json_escape(context.request.pairing_id) << "\""
      << ",\"stream_id\":" << static_cast<int>(context.request.video_stream_id)
      << ",\"last_session_index\":";
  if (context.stream_message_last_session_index > 0) {
    out << context.stream_message_last_session_index;
  } else {
    out << "null";
  }
  out << ",\"sent_count\":" << context.stream_message_sent.load()
      << ",\"received_count\":" << context.stream_message_received.load()
      << ",\"error_count\":" << context.stream_message_errors.load()
      << ",\"last_payload_epoch_seconds\":";
  if (has_last_payload) {
    out << context.stream_message_last_payload_epoch_seconds;
  } else {
    out << "null";
  }
  out << ",\"last_payload_hash\":";
  if (has_last_payload) {
    out << "\"" << json_escape(context.stream_message_last_payload_hash) << "\"";
  } else {
    out << "null";
  }
  out << ",\"last_send_result\":";
  if (context.stream_message_sent.load() > 0) {
    out << context.stream_message_last_send_result;
  } else {
    out << "null";
  }
  out << ",\"first_send_monotonic_ms\":";
  if (context.stream_message_first_send_monotonic_ms >= 0) {
    out << context.stream_message_first_send_monotonic_ms;
  } else {
    out << "null";
  }
  out << ",\"last_send_monotonic_ms\":";
  if (context.stream_message_last_send_monotonic_ms >= 0) {
    out << context.stream_message_last_send_monotonic_ms;
  } else {
    out << "null";
  }
  const bool short_window = context.stream_message_sent.load() < 2;
  out << ",\"matched_receive_count\":" << context.stream_message_matched_receives.load()
      << ",\"periodic_send_ok\":"
      << (context.stream_message_periodic_send_ok || short_window ? "true" : "false")
      << ",\"periodic_window_short\":" << (short_window ? "true" : "false")
      << ",\"stopped_after_disconnect\":";
  if (context.stream_message_stopped_after_disconnect) {
    out << "true";
  } else {
    out << "null";
  }
  out << "}";
  return out.str();
}

std::string nullable_string_json(const std::string& value) {
  if (value.empty()) {
    return "null";
  }
  return "\"" + json_escape(value) + "\"";
}

std::string nullable_reason_json(const std::string& value) {
  if (value.empty()) {
    return "null";
  }
  return "\"" + json_escape(value) + "\"";
}

bool is_device_role(const RoleRequest& request) {
  return request.role == "device" || request.role == "send";
}

bool is_receive_role(const RoleRequest& request) {
  return request.role == "client" || request.role == "receive";
}

bool file_output_requested(const RoleRequest& request) {
  return request.output_mode == "file" || request.output_mode == "both";
}

bool system_output_requested(const RoleRequest& request) {
  return request.output_mode == "system" || request.output_mode == "both";
}

std::string driver_platform() {
#if defined(__APPLE__)
  return "darwin";
#elif defined(__linux__)
  return "linux";
#else
  return "unknown";
#endif
}

std::string driver_arch() {
#if defined(__aarch64__) || defined(_M_ARM64)
  return "arm64";
#elif defined(__x86_64__) || defined(_M_X64)
  return "x64";
#else
  return "unknown";
#endif
}

bool system_io_supported() {
#if defined(__APPLE__) && (defined(__aarch64__) || defined(_M_ARM64))
  return true;
#else
  return false;
#endif
}

std::string capability_state(bool requested) {
  if (!requested) {
    return "not_requested";
  }
  return system_io_supported() ? "supported" : "unsupported";
}

std::string video_bitstream_format(const std::string& codec) {
  if (codec == "h265") {
    return "h265_annexb";
  }
  if (codec == "mjpeg") {
    return "mjpeg_jfif";
  }
  return "h264_annexb";
}

std::string audio_sample_format(const std::string& codec) {
  return codec == "pcm" ? "s16le" : "encoded";
}

std::filesystem::path raw_dump_root(const DriverContext& context) {
  return context.artifact_root / "runtime-log" / "logging" / "media_raw_dump";
}

bool find_raw_dump_file(const std::filesystem::path& root, const std::string& extension,
                        std::filesystem::path* out_path) {
  if (out_path == nullptr || !std::filesystem::exists(root)) {
    return false;
  }
  const std::string suffix = "." + extension;
  std::error_code error;
  for (const auto& entry : std::filesystem::recursive_directory_iterator(root, error)) {
    if (error) {
      return false;
    }
    if (!entry.is_regular_file()) {
      continue;
    }
    const std::string name = entry.path().filename().string();
    if (name.size() >= suffix.size() &&
        name.compare(name.size() - suffix.size(), suffix.size(), suffix) == 0) {
      *out_path = entry.path();
      return true;
    }
  }
  return false;
}

bool copy_file_replace(const std::filesystem::path& source, const std::filesystem::path& target) {
  std::error_code error;
  std::filesystem::create_directories(target.parent_path(), error);
  if (error) {
    return false;
  }
  std::filesystem::copy_file(source, target, std::filesystem::copy_options::overwrite_existing,
                             error);
  return !error;
}

uint64_t file_size_or_zero(const std::filesystem::path& path) {
  std::error_code error;
  const uintmax_t size = std::filesystem::file_size(path, error);
  if (error) {
    return 0;
  }
  return static_cast<uint64_t>(size);
}

bool write_single_packet_index(const std::filesystem::path& path, uint64_t bytes, bool video) {
  std::ostringstream csv;
  if (video) {
    csv << "pts_us,offset,size,is_key_frame\n0,0," << bytes << ",1\n";
  } else {
    csv << "pts_us,offset,size\n0,0," << bytes << "\n";
  }
  return write_text_file(path, csv.str());
}

std::string media_receive_track_json(const std::string& family, int stream_id,
                                     const std::string& codec,
                                     const std::filesystem::path& media_path,
                                     const std::filesystem::path& packet_index_path, uint64_t bytes,
                                     int first_packet_ms, uint32_t sample_rate_hz,
                                     uint32_t channels) {
  std::ostringstream out;
  out << "{\n"
      << "    \"stream_id\": " << stream_id << ",\n"
      << "    \"codec\": \"" << json_escape(codec) << "\",\n"
      << "    \"path\": \"" << json_escape(media_path.string()) << "\",\n"
      << "    \"packet_index_path\": \"" << json_escape(packet_index_path.string()) << "\",\n"
      << "    \"format\": {";
  if (family == "audio") {
    out << "\"codec\":\"" << json_escape(codec) << "\",\"sample_rate_hz\":" << sample_rate_hz
        << ",\"channels\":" << channels << ",\"bits_per_sample\":" << kAudioBitsPerSample
        << ",\"sample_format\":\"" << audio_sample_format(codec) << "\"";
  } else {
    out << "\"codec\":\"" << json_escape(codec) << "\",\"bitstream_format\":\""
        << video_bitstream_format(codec) << "\",\"width\":null,\"height\":null,\"fps\":null";
  }
  out << "},\n"
      << "    \"bytes\": " << bytes << ",\n"
      << "    \"packet_count\": 1,\n"
      << "    \"first_packet_ms\": ";
  if (first_packet_ms >= 0) {
    out << first_packet_ms;
  } else {
    out << "null";
  }
  out << ",\n    \"last_packet_ms\": ";
  if (first_packet_ms >= 0) {
    out << first_packet_ms;
  } else {
    out << "null";
  }
  out << "\n  }";
  return out.str();
}

std::string platform_capabilities_json(const DriverContext& context) {
  const bool input_system_requested = context.request.input_mode == "system";
  const bool output_system_requested_value = system_output_requested(context.request);
  std::ostringstream out;
  out << "{"
      << "\"platform\":\"" << driver_platform() << "\","
      << "\"arch\":\"" << driver_arch() << "\","
      << "\"input_system\":\"" << capability_state(input_system_requested) << "\","
      << "\"output_system\":\"" << capability_state(output_system_requested_value) << "\","
      << "\"preview\":\"" << capability_state(context.request.preview_requested) << "\""
      << "}";
  return out.str();
}

std::string audio_processing_json(const DriverContext& context) {
  const RoleRequest& request = context.request;
  std::ostringstream out;
  out << "{"
      << "\"input\":{"
      << "\"status\":\"" << json_escape(request.audio_input_processing_status) << "\","
      << "\"requested\":{\"aec\":\"" << json_escape(request.audio_input_aec) << "\",\"agc\":\""
      << json_escape(request.audio_input_agc) << "\",\"ans\":\""
      << json_escape(request.audio_input_ans) << "\"},"
      << "\"runtime\":{\"aec_mode\":" << request.audio_input_aec_mode
      << ",\"agc_level\":" << request.audio_input_agc_level
      << ",\"ans_level\":" << request.audio_input_ans_level << "}},"
      << "\"output\":{"
      << "\"status\":\"" << json_escape(request.audio_output_processing_status) << "\","
      << "\"requested\":{\"agc\":\"" << json_escape(request.audio_output_agc) << "\",\"ans\":\""
      << json_escape(request.audio_output_ans) << "\"},"
      << "\"runtime\":{\"agc_level\":" << request.audio_output_agc_level
      << ",\"ans_level\":" << request.audio_output_ans_level << "}}"
      << "}";
  return out.str();
}

std::string system_output_json(const DriverContext& context) {
  const bool requested = system_output_requested(context.request);
  const bool failed = !context.reason_code.empty() && context.reason_code != "ok" &&
                      context.reason_code != "first_output_timeout";
  const std::string audio_state = !requested                                      ? "not_requested"
                                  : context.first_audio_output_ms >= 0            ? "playing"
                                  : context.reason_code == "first_output_timeout" ? "buffering"
                                  : failed                                        ? "failed"
                                                                                  : "started";
  const std::string video_state = !requested                                      ? "not_requested"
                                  : context.first_rendered_frame_ms >= 0          ? "first_frame"
                                  : context.reason_code == "first_output_timeout" ? "buffering"
                                  : failed                                        ? "failed"
                                                                                  : "started";
  std::ostringstream out;
  out << "{"
      << "\"audio\":{"
      << "\"state\":\"" << audio_state << "\","
      << "\"first_playing_ms\":";
  if (requested && context.first_audio_output_ms >= 0) {
    out << context.first_audio_output_ms;
  } else {
    out << "null";
  }
  out << ",\"agc_level\":" << context.request.audio_output_agc_level
      << ",\"ans_level\":" << context.request.audio_output_ans_level << ",\"debug\":{\"codec\":\""
      << (context.request.audio_codec.empty() ? "none" : json_escape(context.request.audio_codec))
      << "\",\"sample_rate_hz\":" << context.request.audio_sample_rate_hz
      << ",\"channels\":" << context.request.audio_channels << "},\"error_code\":";
  if (context.system_audio_error_code != 0) {
    out << context.system_audio_error_code;
  } else {
    out << "null";
  }
  out << "},"
      << "\"video\":{"
      << "\"state\":\"" << video_state << "\","
      << "\"first_frame_ms\":";
  if (requested && context.first_rendered_frame_ms >= 0) {
    out << context.first_rendered_frame_ms;
  } else {
    out << "null";
  }
  out << ",\"frame_count\":" << (requested ? context.decoded_video_frame_count : 0)
      << ",\"debug\":{\"codec\":\""
      << (context.actual_video_codec.empty() ? "none" : json_escape(context.actual_video_codec))
      << "\",\"width\":" << context.system_video_width
      << ",\"height\":" << context.system_video_height << ",\"bitstream_format\":\""
      << (context.actual_video_codec.empty() ? "none"
                                             : video_bitstream_format(context.actual_video_codec))
      << "\"},\"error_code\":";
  if (context.system_video_error_code != 0) {
    out << context.system_video_error_code;
  } else {
    out << "null";
  }
  out << "}}";
  return out.str();
}

std::string preview_json(const DriverContext& context) {
  const std::string state =
      context.request.preview_requested
          ? (context.preview_state.empty() ? "not_started" : context.preview_state)
          : "not_requested";
  std::ostringstream out;
  out << "{"
      << "\"requested\":" << (context.request.preview_requested ? "true" : "false") << ","
      << "\"state\":\"" << json_escape(state) << "\","
      << "\"first_frame_ms\":";
  if (context.preview_first_frame_ms >= 0) {
    out << context.preview_first_frame_ms;
  } else {
    out << "null";
  }
  out << ","
      << "\"frame_count\":" << context.preview_frame_count << ","
      << "\"error_code\":";
  if (context.preview_error_code != 0) {
    out << context.preview_error_code;
  } else {
    out << "null";
  }
  out << "}";
  return out.str();
}

std::string received_audio_summary_json(const DriverContext& context, bool metadata_shape) {
  const bool enabled = context.request.receive_audio_enabled || context.received_audio_enabled;
  const std::string codec =
      context.received_audio_codec.empty() ? "pcm" : context.received_audio_codec;
  const uint32_t sample_rate_hz =
      context.received_audio_sample_rate_hz == 0 ? 16000 : context.received_audio_sample_rate_hz;
  const uint32_t channels =
      context.received_audio_channels == 0 ? 1 : context.received_audio_channels;
  std::ostringstream out;
  out << "{";
  if (metadata_shape) {
    out << "\n  \"artifact_root\": \"" << json_escape(context.artifact_root.string()) << "\","
        << "\n  \"started_at\": \"" << json_escape(context.started_at) << "\","
        << "\n  \"finished_at\": \"" << json_escape(context.finished_at) << "\",";
  }
  out << "\n  \"enabled\": " << (enabled ? "true" : "false") << ","
      << "\n  \"stream_id\": " << context.request.receive_audio_stream_id << ","
      << "\n  \"codec\": \"" << json_escape(codec) << "\","
      << "\n  \"sample_rate_hz\": " << sample_rate_hz << ","
      << "\n  \"channels\": " << channels << ","
      << "\n  \"bits_per_sample\": " << kAudioBitsPerSample << ","
      << "\n  \"sample_format\": \"s16le\","
      << "\n  \"first_output_timing_ms\": ";
  if (context.received_audio_first_output_timing_ms >= 0) {
    out << context.received_audio_first_output_timing_ms;
  } else {
    out << "null";
  }
  out << ","
      << "\n  \"captured_bytes\": " << context.received_audio_captured_bytes << ","
      << "\n  \"pcm_path\": \"" << json_escape(context.received_audio_pcm_path) << "\","
      << "\n  \"metadata_path\": \"" << json_escape(context.received_audio_metadata_path) << "\","
      << "\n  \"mp3_path\": " << nullable_string_json(context.received_audio_mp3_path) << ","
      << "\n  \"mp3_status\": \"" << json_escape(context.received_audio_mp3_status) << "\","
      << "\n  \"mp3_reason_code\": " << nullable_reason_json(context.received_audio_mp3_reason_code)
      << "\n}";
  return out.str();
}

std::string build_summary_json(const DriverContext& context) {
  std::ostringstream summary;
  summary << "{\n"
          << "  \"schema_version\": " << kDriverSchemaVersion << ",\n"
          << "  \"execution_id\": \"" << json_escape(context.request.execution_id) << "\",\n";
  if (!context.request.case_id.empty()) {
    summary << "  \"case_id\": \"" << json_escape(context.request.case_id) << "\",\n";
  }
  summary << "  \"pairing_id\": \"" << json_escape(context.request.pairing_id) << "\",\n";
  if (!context.bootstrap_id.empty()) {
    summary << "  \"bootstrap_id\": \"" << json_escape(context.bootstrap_id) << "\",\n";
  }
  const std::string bootstrap_status = is_device_role(context.request)
                                           ? (context.bootstrap_path.empty() ? "failed" : "written")
                                           : (context.bootstrap_path.empty() ? "failed" : "read");
  summary << "  \"driver_version\": \"" << kDriverVersion << "\",\n"
          << "  \"runtime_version\": \"runtime-bundle\",\n"
          << "  \"role\": \"" << json_escape(context.request.role) << "\",\n"
          << "  \"status\": \"" << context.status << "\",\n"
          << "  \"reason_code\": \""
          << json_escape(context.reason_code.empty() ? "ok" : context.reason_code) << "\",\n"
          << "  \"exit_code\": " << context.exit_code << ",\n"
          << "  \"started_at\": \"" << context.started_at << "\",\n"
          << "  \"ready_at\": " << nullable_string_json(context.ready_at) << ",\n"
          << "  \"finished_at\": \"" << context.finished_at << "\",\n"
          << "  \"stop_reason\": " << nullable_string_json(context.stop_reason) << ",\n"
          << "  \"cache_dir\": \"" << json_escape(context.request.cache_dir) << "\",\n"
          << "  \"role_dir\": \"" << json_escape(context.request.role_dir) << "\",\n"
          << "  \"input_mode\": " << nullable_string_json(context.request.input_mode) << ",\n"
          << "  \"output_mode\": \"" << json_escape(context.request.output_mode) << "\",\n"
          << "  \"pairing_mode\": \"" << json_escape(context.request.pairing_mode) << "\",\n"
          << "  \"bootstrap_status\": \"" << bootstrap_status << "\",\n"
          << "  \"endpoint_mode\": \"" << json_escape(context.request.endpoint_mode) << "\",\n"
          << "  \"media_input_path\": " << nullable_string_json(context.request.media_input_path)
          << ",\n"
          << "  \"media_receive_path\": " << nullable_string_json(context.media_receive_path)
          << ",\n"
          << "  \"platform_capabilities\": " << platform_capabilities_json(context) << ",\n"
          << "  \"audio_processing\": " << audio_processing_json(context) << ",\n"
          << "  \"system_output\": " << system_output_json(context) << ",\n"
          << "  \"preview\": " << preview_json(context) << ",\n";
  summary << "  \"stage_status\": " << stage_summary_json(context) << ",\n";
  if (!context.bootstrap_path.empty()) {
    summary << "  \"bootstrap_path\": \"" << json_escape(context.bootstrap_path) << "\",\n";
  }
  if (!context.requested_video_codec.empty()) {
    summary << "  \"requested_video_codec\": \"" << json_escape(context.requested_video_codec)
            << "\",\n";
  }
  if (!context.actual_video_codec.empty()) {
    summary << "  \"actual_video_codec\": \"" << json_escape(context.actual_video_codec) << "\",\n";
  }
  if (!context.media_path.empty()) {
    summary << "  \"media_path\": \"" << json_escape(context.media_path) << "\",\n";
  }
  if (!context.audio_media_path.empty()) {
    summary << "  \"audio_media_path\": \"" << json_escape(context.audio_media_path) << "\",\n";
  }
  if (!context.video_media_path.empty()) {
    summary << "  \"video_media_path\": \"" << json_escape(context.video_media_path) << "\",\n";
  }
  if (!context.audio_media_path.empty() || !context.video_media_path.empty()) {
    summary << "  \"media_paths\": {\n";
    bool first_media_path = true;
    if (!context.audio_media_path.empty()) {
      summary << "    \"audio\": \"" << json_escape(context.audio_media_path) << "\"";
      first_media_path = false;
    }
    if (!context.video_media_path.empty()) {
      if (!first_media_path) {
        summary << ",\n";
      }
      summary << "    \"video\": \"" << json_escape(context.video_media_path) << "\"";
    }
    summary << "\n  },\n";
  }
  if (!context.output_consumer.empty()) {
    summary << "  \"output_consumer\": \"" << json_escape(context.output_consumer) << "\",\n";
    summary << "  \"render_backend\": \"apple_pixel_buffer_callback\",\n";
    summary << "  \"decoded_video_frame_count\": " << context.decoded_video_frame_count << ",\n";
  }
  if (context.first_audio_packet_ms >= 0) {
    summary << "  \"first_audio_packet_ms\": " << context.first_audio_packet_ms << ",\n";
  }
  summary << "  \"audio\": {\n"
          << "    \"audio_codec\": \"" << json_escape(context.request.audio_codec) << "\",\n"
          << "    \"sample_rate_hz\": " << context.request.audio_sample_rate_hz << ",\n"
          << "    \"channels\": " << context.request.audio_channels << ",\n"
          << "    \"bits_per_sample\": " << kAudioBitsPerSample << ",\n"
          << "    \"audio_asset_key\": \"" << json_escape(context.audio_asset_key) << "\",\n"
          << "    \"audio_packet_count\": " << context.audio_packet_count << ",\n"
          << "    \"packet_count\": " << context.audio_packet_count << ",\n"
          << "    \"audio_bytes\": " << context.audio_bytes << ",\n"
          << "    \"bytes\": " << context.audio_bytes << ",\n"
          << "    \"first_audio_packet_ms\": " << context.first_audio_packet_ms << ",\n"
          << "    \"first_packet_ms\": " << context.first_audio_packet_ms << ",\n"
          << "    \"first_output_ms\": " << context.first_audio_output_ms << ",\n"
          << "    \"first_output\": " << (context.first_audio_output_ms >= 0 ? "true" : "false")
          << "\n"
          << "  },\n";
  if (context.request.receive_audio_enabled || context.received_audio_enabled) {
    summary << "  \"received_audio\": " << received_audio_summary_json(context, false) << ",\n";
  }
  if (context.first_video_packet_ms >= 0) {
    summary << "  \"first_video_packet_ms\": " << context.first_video_packet_ms << ",\n";
  }
  summary << "  \"video\": {\n"
          << "    \"codec\": \"" << json_escape(context.request.video_codec) << "\",\n"
          << "    \"video_packet_count\": " << context.video_packet_count << ",\n"
          << "    \"packet_count\": " << context.video_packet_count << ",\n"
          << "    \"video_bytes\": " << context.video_bytes << ",\n"
          << "    \"bytes\": " << context.video_bytes << ",\n"
          << "    \"first_video_packet_ms\": " << context.first_video_packet_ms << ",\n"
          << "    \"first_packet_ms\": " << context.first_video_packet_ms << "\n"
          << "  },\n";
  if (context.first_key_frame_ms >= 0) {
    summary << "  \"first_key_frame_ms\": " << context.first_key_frame_ms << ",\n";
  }
  if (context.first_decoded_frame_ms >= 0) {
    summary << "  \"first_decoded_frame_ms\": " << context.first_decoded_frame_ms << ",\n";
  }
  if (context.first_rendered_frame_ms >= 0) {
    summary << "  \"first_rendered_frame_ms\": " << context.first_rendered_frame_ms << ",\n";
  }
  if (!context.log_upload_status.empty()) {
    summary << "  \"log_upload\": {\n"
            << "    \"status\": \"" << json_escape(context.log_upload_status) << "\"";
    if (!context.log_id.empty()) {
      summary << ",\n    \"log_id\": \"" << json_escape(context.log_id) << "\"";
    }
    if (!context.log_upload_reason_code.empty()) {
      summary << ",\n    \"reason_code\": \"" << json_escape(context.log_upload_reason_code)
              << "\"";
    }
    if (context.log_upload_error_code != 0) {
      summary << ",\n    \"error_code\": " << context.log_upload_error_code;
    }
    summary << "\n  },\n";
  }
  summary << "  \"command_echo\": " << command_echo_summary_json(context) << ",\n";
  summary << "  \"stream_message\": " << stream_message_summary_json(context) << ",\n";
  summary << "  \"artifact_paths\": {\n"
          << "    \"events\": \"" << json_escape((context.artifact_root / "events.jsonl").string())
          << "\",\n"
          << "    \"summary\": \"" << json_escape((context.artifact_root / "summary.json").string())
          << "\",\n"
          << "    \"request_redacted\": \""
          << json_escape((context.artifact_root / "request.redacted.json").string()) << "\"\n"
          << "  }\n"
          << "}\n";
  return summary.str();
}

}  // namespace

void init_stages(DriverContext* context) {
  const char* names[] = {"preflight",  "endpoint",      "bootstrap", "connect",
                         "media_send", "media_receive", "key_frame", "decode",
                         "output",     "log_upload",    "artifact"};
  for (const char* name : names) {
    context->stages[name] = StageStatus{};
  }
}

std::string emit_event(DriverContext* context, const std::string& level, const std::string& family,
                       const std::string& kind, const std::string& payload) {
  std::lock_guard<std::mutex> guard(context->events_lock);
  context->event_index += 1;
  const std::string event_id = "event-" + std::to_string(context->event_index);
  context->events << "{\"schema_version\":" << kDriverSchemaVersion << ",\"execution_id\":\""
                  << json_escape(context->request.execution_id) << "\"";
  if (!context->request.case_id.empty()) {
    context->events << ",\"case_id\":\"" << json_escape(context->request.case_id) << "\"";
  }
  if (!context->bootstrap_id.empty()) {
    context->events << ",\"bootstrap_id\":\"" << json_escape(context->bootstrap_id) << "\"";
  }
  context->events << ",\"event_id\":\"" << event_id << "\",\"timestamp\":\"" << now_rfc3339()
                  << "\",\"level\":\"" << level << "\",\"family\":\"" << family << "\",\"kind\":\""
                  << kind << "\",\"role\":\"" << json_escape(context->request.role)
                  << "\",\"payload\":" << payload << "}\n";
  context->events.flush();
  return event_id;
}

void start_stage(DriverContext* context, const std::string& stage) {
  StageStatus& status = context->stages[stage];
  status.status = StageResult::Running;
  status.started_at = now_rfc3339();
}

void finish_stage(DriverContext* context, const std::string& stage, StageResult result,
                  const std::string& reason_code, const std::string& evidence_event_id) {
  StageStatus& status = context->stages[stage];
  status.status = result;
  status.reason_code = reason_code;
  status.finished_at = now_rfc3339();
  status.evidence_event_id = evidence_event_id;
}

bool validate_preflight(DriverContext* context, const std::string& request_json,
                        std::string* out_reason) {
  start_stage(context, "preflight");
  const std::string preflight_start = emit_event(
      context, "info", "preflight", "preflight.start",
      "{\"driver_path\":\"devtools_driver_probe\",\"runtime_root\":\"" +
          json_escape(context->runtime_root) + "\",\"artifact_root\":\"" +
          json_escape(context->artifact_root.string()) +
          "\",\"request_schema_version\":" + std::to_string(context->request.schema_version) + "}");

  const bool device_role = is_device_role(context->request);
  const bool receive_role = is_receive_role(context->request);
  const bool fixed_cache_input =
      !context->asset_root.empty() && asset_root_uses_fixed_cache(context->asset_root);
  if (context->request.schema_version != kRequestSchemaVersion) {
    *out_reason = "schema_incompatible";
  } else if (!is_safe_execution_id(context->request.execution_id)) {
    *out_reason = "invalid_request";
  } else if (context->request.role != "device" && context->request.role != "client" &&
             context->request.role != "send" && context->request.role != "receive") {
    *out_reason = "invalid_request";
  } else if (device_role &&
             (context->request.remote_id.empty() || context->request.device_secret_key.empty())) {
    *out_reason = "missing_env";
  } else if (device_role && context->request.receive_audio_enabled &&
             (context->request.receive_audio_stream_id < 1 ||
              context->request.receive_audio_stream_id > 255)) {
    *out_reason = "invalid_request";
  } else if (receive_role &&
             (context->request.remote_id.empty() || context->request.token.empty())) {
    *out_reason = "missing_env";
  } else if (device_role && context->request.media_source_path.empty() &&
             context->asset_root.empty()) {
    *out_reason = "asset_missing";
  } else if (receive_role && context->request.output_consumer != "frame_dump" &&
             context->request.output_consumer != "packet_dump" &&
             context->request.output_consumer != "system") {
    *out_reason = "invalid_request";
  } else if (device_role &&
             (context->request.audio_codec != "pcm" && context->request.audio_codec != "g711a" &&
              context->request.audio_codec != "aac" && context->request.audio_codec != "opus" &&
              context->request.audio_codec != "amr")) {
    *out_reason = "audio_codec_unsupported";
  } else if (device_role && (context->request.audio_sample_rate_hz != 8000 &&
                             context->request.audio_sample_rate_hz != 16000)) {
    *out_reason = "audio_format_unsupported";
  } else if (device_role &&
             (context->request.audio_channels != 1 && context->request.audio_channels != 2)) {
    *out_reason = "audio_format_unsupported";
  } else if (device_role && context->request.audio_codec == "amr" &&
             (context->request.audio_sample_rate_hz != 8000 ||
              context->request.audio_channels != 1)) {
    *out_reason = "audio_format_unsupported";
  } else if (!std::filesystem::exists(std::filesystem::path(context->runtime_root) / "include" /
                                      "tirtc" / "av.h") ||
             (!std::filesystem::exists(std::filesystem::path(context->runtime_root) / "lib" /
                                       "libtirtc_av.dylib") &&
              !std::filesystem::exists(std::filesystem::path(context->runtime_root) / "lib" /
                                       "libtirtc_av.so"))) {
    *out_reason = "runtime_bundle_missing";
  } else if (device_role && !context->asset_root.empty() &&
             (!std::filesystem::exists(audio_media_path(
                  context->asset_root, context->request.audio_codec,
                  context->request.audio_sample_rate_hz, context->request.audio_channels)) ||
              !std::filesystem::exists(audio_packets_path(
                  context->asset_root, context->request.audio_codec,
                  context->request.audio_sample_rate_hz, context->request.audio_channels)))) {
    *out_reason = "audio_asset_missing";
  } else if (fixed_cache_input &&
             (!std::filesystem::exists(std::filesystem::path(context->asset_root) /
                                       "media_input.json") ||
              !std::filesystem::exists(
                  codec_media_path(context->asset_root, context->request.video_codec)) ||
              !std::filesystem::exists(
                  codec_packets_path(context->asset_root, context->request.video_codec)))) {
    *out_reason = "asset_missing";
  } else if (!context->asset_root.empty() && !fixed_cache_input &&
             (!std::filesystem::exists(std::filesystem::path(context->asset_root) /
                                       "manifest.json") ||
              !std::filesystem::exists(codec_media_path(context->asset_root, "h264")) ||
              !std::filesystem::exists(codec_media_path(context->asset_root, "h265")) ||
              !std::filesystem::exists(codec_media_path(context->asset_root, "mjpeg")) ||
              !std::filesystem::exists(codec_packets_path(context->asset_root, "h264")) ||
              !std::filesystem::exists(codec_packets_path(context->asset_root, "h265")) ||
              !std::filesystem::exists(codec_packets_path(context->asset_root, "mjpeg")))) {
    *out_reason = "asset_missing";
  }

  if (!out_reason->empty()) {
    const std::string event_id = emit_event(
        context, "error", "preflight", "preflight.failed",
        "{\"reason_code\":\"" + *out_reason + "\",\"detail\":\"preflight validation failed\"}");
    finish_stage(context, "preflight", StageResult::Failed, *out_reason, event_id);
    (void)preflight_start;
    return false;
  }

  const std::string event_id = emit_event(
      context, "info", "preflight", "preflight.done",
      "{\"driver_version\":\"" + std::string(kDriverVersion) +
          "\",\"runtime_version\":\"runtime-bundle\",\"asset_root\":\"" +
          json_escape(context->asset_root) + "\",\"supported_request_schema_versions\":[1]}");
  finish_stage(context, "preflight", StageResult::Passed, "ok", event_id);
  (void)write_text_file(context->artifact_root / "request.redacted.json",
                        redact_request_json(request_json));
  return true;
}

bool write_media_receive_artifacts(DriverContext* context) {
  if (context == nullptr || !file_output_requested(context->request)) {
    return true;
  }
  const bool receive_role = is_receive_role(context->request);
  const bool device_audio_receive =
      is_device_role(context->request) && context->request.receive_audio_enabled;
  if (!receive_role && !device_audio_receive) {
    return true;
  }

  const std::filesystem::path output_dir = context->artifact_root / "output";
  const std::filesystem::path dump_root = raw_dump_root(*context);
  const std::string video_codec = context->actual_video_codec.empty() ? context->request.video_codec
                                                                      : context->actual_video_codec;
  const std::string audio_codec =
      device_audio_receive
          ? (context->received_audio_codec.empty() ? "g711a" : context->received_audio_codec)
          : (context->request.audio_codec.empty() ? "g711a" : context->request.audio_codec);

  std::filesystem::path video_dump;
  std::filesystem::path audio_dump;
  const bool has_video_dump =
      receive_role && find_raw_dump_file(dump_root, video_codec, &video_dump);
  const bool has_audio_dump = find_raw_dump_file(dump_root, audio_codec, &audio_dump);
  if ((receive_role && !has_video_dump) ||
      ((context->request.require_audio || device_audio_receive) && !has_audio_dump)) {
    context->reason_code = "file_output_failed";
    return false;
  }

  std::filesystem::path video_output;
  std::filesystem::path video_packets;
  uint64_t video_bytes = 0;
  if (receive_role) {
    video_output = output_dir / ("video_receive." + video_codec);
    video_packets = output_dir / ("video_receive." + video_codec + ".packets.csv");
    if (!copy_file_replace(video_dump, video_output)) {
      context->reason_code = "file_output_failed";
      return false;
    }
    video_bytes = file_size_or_zero(video_output);
    if (video_bytes == 0 || !write_single_packet_index(video_packets, video_bytes, true)) {
      context->reason_code = "file_output_failed";
      return false;
    }
    context->video_bytes = video_bytes;
    context->video_packet_count = 1;
    context->video_media_path = video_output.string();
  }

  bool has_audio_output = false;
  std::filesystem::path audio_output;
  std::filesystem::path audio_packets;
  uint64_t audio_bytes = 0;
  if (has_audio_dump) {
    audio_output = output_dir / ("audio_receive." + audio_codec);
    audio_packets = output_dir / ("audio_receive." + audio_codec + ".packets.csv");
    if (!copy_file_replace(audio_dump, audio_output)) {
      context->reason_code = "file_output_failed";
      return false;
    }
    audio_bytes = file_size_or_zero(audio_output);
    if (audio_bytes == 0 || !write_single_packet_index(audio_packets, audio_bytes, false)) {
      context->reason_code = "file_output_failed";
      return false;
    }
    context->audio_bytes = audio_bytes;
    context->audio_packet_count = 1;
    context->audio_media_path = audio_output.string();
    if (device_audio_receive) {
      context->received_audio_captured_bytes = audio_bytes;
      context->received_audio_mp3_status = "skipped";
      context->received_audio_mp3_reason_code = "raw_media_receive";
    }
    has_audio_output = true;
  }

  const std::filesystem::path media_receive_path = output_dir / "media_receive.json";
  std::ostringstream json;
  json << "{\n"
       << "  \"schema_version\": 1,\n"
       << "  \"role\": \"" << json_escape(context->request.role) << "\",\n"
       << "  \"started_at\": \"" << json_escape(context->started_at) << "\",\n"
       << "  \"finished_at\": \"" << json_escape(now_rfc3339()) << "\",\n"
       << "  \"audio\": ";
  if (has_audio_output) {
    const int audio_stream_id = device_audio_receive
                                    ? context->request.receive_audio_stream_id
                                    : static_cast<int>(context->request.audio_stream_id);
    const int first_audio_ms = device_audio_receive ? context->received_audio_first_output_timing_ms
                                                    : context->first_audio_packet_ms;
    const uint32_t audio_sample_rate_hz = device_audio_receive
                                              ? context->received_audio_sample_rate_hz
                                              : context->request.audio_sample_rate_hz;
    const uint32_t audio_channels =
        device_audio_receive ? context->received_audio_channels : context->request.audio_channels;
    json << media_receive_track_json("audio", audio_stream_id, audio_codec, audio_output,
                                     audio_packets, audio_bytes, first_audio_ms,
                                     audio_sample_rate_hz, audio_channels);
  } else {
    json << "null";
  }
  json << ",\n  \"video\": ";
  if (receive_role) {
    json << media_receive_track_json(
        "video", static_cast<int>(context->request.video_stream_id), video_codec, video_output,
        video_packets, video_bytes, context->first_video_packet_ms,
        context->request.audio_sample_rate_hz, context->request.audio_channels);
  } else {
    json << "null";
  }
  json << "\n}\n";
  if (!write_text_file(media_receive_path, json.str())) {
    context->reason_code = "file_output_failed";
    return false;
  }
  context->media_receive_path = media_receive_path.string();
  return true;
}

bool upload_logs_on_failure(DriverContext* context) {
  if (context == nullptr) {
    return false;
  }
  if (!context->log_upload_status.empty()) {
    return context->log_upload_status == "passed";
  }

  start_stage(context, "log_upload");
  (void)emit_event(context, "info", "artifact", "log_upload.start",
                   "{\"reason_code\":\"" + json_escape(context->reason_code) + "\"}");

  char log_id[256] = {0};
  const TirtcError status = tirtc_logging_upload(log_id, static_cast<int>(sizeof(log_id)));
  if (status == TIRTC_ERROR_OK && log_id[0] != '\0') {
    context->log_upload_status = "passed";
    context->log_id = log_id;
    const std::string event_id =
        emit_event(context, "info", "artifact", "log_upload.completed",
                   "{\"log_id\":\"" + json_escape(context->log_id) + "\"}");
    finish_stage(context, "log_upload", StageResult::Passed, "ok", event_id);
    return true;
  }

  const TirtcError effective_status =
      status == TIRTC_ERROR_OK ? TIRTC_ERROR_LOG_UPLOAD_FAILED : status;
  context->log_upload_status = "failed";
  context->log_upload_error_code = static_cast<int>(effective_status);
  context->log_upload_reason_code = tirtc_error_to_string(effective_status);
  const std::string event_id =
      emit_event(context, "error", "artifact", "log_upload.failed",
                 "{\"reason_code\":\"" + json_escape(context->log_upload_reason_code) +
                     "\",\"error_code\":" + std::to_string(context->log_upload_error_code) + "}");
  finish_stage(context, "log_upload", StageResult::Failed, context->log_upload_reason_code,
               event_id);
  return false;
}

bool write_summary(DriverContext* context) {
  start_stage(context, "artifact");
  context->finished_at = now_rfc3339();
  const std::filesystem::path summary_path = context->artifact_root / "summary.json";
  if (context->request.receive_audio_enabled || context->received_audio_enabled) {
    (void)write_text_file(context->artifact_root / context->received_audio_metadata_path,
                          received_audio_summary_json(*context, true) + "\n");
  }
  if (!write_text_file(summary_path, build_summary_json(*context))) {
    finish_stage(context, "artifact", StageResult::Failed, "artifact_write_failed", "");
    return false;
  }
  const std::string event_id =
      emit_event(context, "info", "artifact", "artifact.summary.write.done",
                 "{\"summary_path\":\"" + json_escape(summary_path.string()) + "\"}");
  finish_stage(context, "artifact", StageResult::Passed, "ok", event_id);
  return write_text_file(summary_path, build_summary_json(*context));
}

}  // namespace devtools_driver_probe
