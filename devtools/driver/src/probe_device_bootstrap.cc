#include "probe_device_bootstrap.h"

#include <sstream>

namespace devtools_driver_probe {

bool write_device_bootstrap_and_ready(DriverContext* context) {
  start_stage(context, "bootstrap");
  context->bootstrap_id = context->request.execution_id + "-bootstrap";
  context->bootstrap_path = (context->artifact_root / "bootstrap.json").string();

  const std::string endpoint_mode =
      context->request.endpoint_mode.empty() ? "default" : context->request.endpoint_mode;
  std::ostringstream bootstrap;
  bootstrap << "{\n"
            << "  \"schema_version\": " << kRequestSchemaVersion << ",\n"
            << "  \"bootstrap_id\": \"" << json_escape(context->bootstrap_id) << "\",\n"
            << "  \"execution_id\": \"" << json_escape(context->request.execution_id) << "\",\n"
            << "  \"pairing_id\": \"" << json_escape(context->request.pairing_id) << "\",\n"
            << "  \"created_at\": \"" << now_rfc3339() << "\",\n"
            << "  \"producer\": \"cli_device\",\n"
            << "  \"app_id\": \"" << json_escape(context->request.app_id) << "\",\n"
            << "  \"endpoint_mode\": \"" << json_escape(endpoint_mode) << "\",\n";
  if (endpoint_mode == "custom" && !context->request.endpoint.empty()) {
    bootstrap << "  \"endpoint\": \"" << json_escape(context->request.endpoint) << "\",\n";
  }
  bootstrap << "  \"device_id\": \"" << json_escape(context->request.remote_id) << "\",\n"
            << "  \"remote_id\": \"" << json_escape(context->request.remote_id) << "\",\n"
            << "  \"token\": \"" << json_escape(context->request.token) << "\",\n"
            << "  \"token_fingerprint\": \"" << json_escape(context->request.token_fingerprint)
            << "\",\n"
            << "  \"require_audio\": true,\n"
            << "  \"require_control_probe\": false,\n"
            << "  \"audio_stream_id\": " << static_cast<int>(context->request.audio_stream_id)
            << ",\n"
            << "  \"video_stream_id\": " << static_cast<int>(context->request.video_stream_id)
            << ",\n"
            << "  \"audio_codec\": \"" << json_escape(context->request.audio_codec) << "\",\n"
            << "  \"sample_rate_hz\": " << context->request.audio_sample_rate_hz << ",\n"
            << "  \"channels\": " << context->request.audio_channels << ",\n"
            << "  \"bits_per_sample\": " << kAudioBitsPerSample << ",\n"
            << "  \"video_codec\": \"" << json_escape(context->request.video_codec) << "\""
            << "\n}\n";

  if (!write_text_file(context->bootstrap_path, bootstrap.str())) {
    context->reason_code = "artifact_write_failed";
    finish_stage(context, "bootstrap", StageResult::Failed, "artifact_write_failed", "");
    return false;
  }

  const std::string bootstrap_event = emit_event(
      context, "info", "bootstrap", "bootstrap.write.done",
      "{\"bootstrap_id\":\"" + json_escape(context->bootstrap_id) + "\",\"path\":\"" +
          json_escape(context->bootstrap_path) + "\",\"device_id\":\"" +
          json_escape(context->request.remote_id) + "\",\"endpoint_mode\":\"" +
          json_escape(endpoint_mode) + "\",\"audio_stream_id\":" +
          std::to_string(static_cast<int>(context->request.audio_stream_id)) +
          ",\"video_stream_id\":" +
          std::to_string(static_cast<int>(context->request.video_stream_id)) + "}");
  finish_stage(context, "bootstrap", StageResult::Passed, "ok", bootstrap_event);

  context->ready_at = now_rfc3339();
  (void)emit_event(context, "info", "role", "role.ready",
                   "{\"bootstrap_id\":\"" + json_escape(context->bootstrap_id) +
                       "\",\"bootstrap_path\":\"" + json_escape(context->bootstrap_path) +
                       "\",\"endpoint_mode\":\"" + json_escape(endpoint_mode) + "\"}");
  return true;
}

}  // namespace devtools_driver_probe
