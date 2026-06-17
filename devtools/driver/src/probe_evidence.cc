#include <mutex>
#include <sstream>

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

std::string build_summary_json(const DriverContext& context) {
  std::ostringstream summary;
  summary << "{\n"
          << "  \"schema_version\": " << kDriverSchemaVersion << ",\n"
          << "  \"execution_id\": \"" << json_escape(context.request.execution_id) << "\",\n";
  if (!context.request.case_id.empty()) {
    summary << "  \"case_id\": \"" << json_escape(context.request.case_id) << "\",\n";
  }
  if (!context.bootstrap_id.empty()) {
    summary << "  \"bootstrap_id\": \"" << json_escape(context.bootstrap_id) << "\",\n";
  }
  summary << "  \"driver_version\": \"" << kDriverVersion << "\",\n"
          << "  \"runtime_version\": \"runtime-bundle\",\n"
          << "  \"role\": \"" << json_escape(context.request.role) << "\",\n"
          << "  \"status\": \"" << context.status << "\",\n"
          << "  \"exit_code\": " << context.exit_code << ",\n"
          << "  \"started_at\": \"" << context.started_at << "\",\n"
          << "  \"finished_at\": \"" << context.finished_at << "\",\n";
  if (!context.reason_code.empty()) {
    summary << "  \"reason_code\": \"" << json_escape(context.reason_code) << "\",\n";
  }
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

  if (context->request.schema_version != kRequestSchemaVersion) {
    *out_reason = "schema_incompatible";
  } else if (!is_safe_execution_id(context->request.execution_id)) {
    *out_reason = "invalid_request";
  } else if (context->request.role != "device" && context->request.role != "client" &&
             context->request.role != "send" && context->request.role != "receive") {
    *out_reason = "invalid_request";
  } else if ((context->request.role == "device" || context->request.role == "send") &&
             (context->request.remote_id.empty() || context->request.device_secret_key.empty())) {
    *out_reason = "missing_env";
  } else if ((context->request.role == "client" || context->request.role == "receive") &&
             (context->request.remote_id.empty() || context->request.token.empty())) {
    *out_reason = "missing_env";
  } else if ((context->request.role == "device" || context->request.role == "send") &&
             context->request.media_source_path.empty() && context->asset_root.empty()) {
    *out_reason = "asset_missing";
  } else if ((context->request.role == "client" || context->request.role == "receive") &&
             context->request.output_consumer != "frame_dump") {
    *out_reason = "invalid_request";
  } else if ((context->request.role == "device" || context->request.role == "send") &&
             (context->request.audio_codec != "pcm" && context->request.audio_codec != "g711a" &&
              context->request.audio_codec != "aac" && context->request.audio_codec != "opus" &&
              context->request.audio_codec != "amr")) {
    *out_reason = "audio_codec_unsupported";
  } else if ((context->request.role == "device" || context->request.role == "send") &&
             (context->request.audio_sample_rate_hz != 8000 &&
              context->request.audio_sample_rate_hz != 16000)) {
    *out_reason = "audio_format_unsupported";
  } else if ((context->request.role == "device" || context->request.role == "send") &&
             (context->request.audio_channels != 1 && context->request.audio_channels != 2)) {
    *out_reason = "audio_format_unsupported";
  } else if ((context->request.role == "device" || context->request.role == "send") &&
             context->request.audio_codec == "amr" &&
             (context->request.audio_sample_rate_hz != 8000 ||
              context->request.audio_channels != 1)) {
    *out_reason = "audio_format_unsupported";
  } else if (!std::filesystem::exists(std::filesystem::path(context->runtime_root) / "include" /
                                      "tirtc" / "av.h") ||
             !std::filesystem::exists(std::filesystem::path(context->runtime_root) / "lib" /
                                      "libmatrix_runtime_facade.a")) {
    *out_reason = "runtime_bundle_missing";
  } else if ((context->request.role == "device" || context->request.role == "send") &&
             !context->asset_root.empty() &&
             (!std::filesystem::exists(audio_media_path(
                  context->asset_root, context->request.audio_codec,
                  context->request.audio_sample_rate_hz, context->request.audio_channels)) ||
              !std::filesystem::exists(audio_packets_path(
                  context->asset_root, context->request.audio_codec,
                  context->request.audio_sample_rate_hz, context->request.audio_channels)))) {
    *out_reason = "audio_asset_missing";
  } else if (!context->asset_root.empty() &&
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
