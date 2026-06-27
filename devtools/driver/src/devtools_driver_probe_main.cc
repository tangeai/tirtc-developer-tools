#include <chrono>
#include <csignal>
#include <filesystem>
#include <iostream>
#include <string>

#include "probe_common.h"

namespace {

void print_usage() {
  std::cerr << "Usage: devtools_driver_probe --request FILE --runtime-root DIR --asset-root DIR "
               "[--artifact-root DIR]\n";
}

}  // namespace

int main(int argc, char** argv) {
  using namespace devtools_driver_probe;

  std::signal(SIGINT, on_signal);
  std::signal(SIGTERM, on_signal);

  DriverContext context{};
  context.started_at = now_rfc3339();
  context.monotonic_started_at = std::chrono::steady_clock::now();
  init_stages(&context);

  for (int index = 1; index < argc; ++index) {
    const std::string arg = argv[index];
    auto require_value = [&](std::string* target) -> bool {
      if (index + 1 >= argc) {
        return false;
      }
      *target = argv[++index];
      return true;
    };
    if (arg == "--request") {
      if (!require_value(&context.request_path)) {
        print_usage();
        return kExitUsage;
      }
    } else if (arg == "--runtime-root") {
      if (!require_value(&context.runtime_root)) {
        print_usage();
        return kExitUsage;
      }
    } else if (arg == "--asset-root") {
      if (!require_value(&context.asset_root)) {
        print_usage();
        return kExitUsage;
      }
    } else if (arg == "--artifact-root") {
      std::string artifact_root;
      if (!require_value(&artifact_root)) {
        print_usage();
        return kExitUsage;
      }
      context.artifact_root = artifact_root;
    } else if (arg == "-h" || arg == "--help") {
      print_usage();
      return 0;
    } else {
      print_usage();
      return kExitUsage;
    }
  }

  if (context.request_path.empty() || context.runtime_root.empty() || context.asset_root.empty()) {
    print_usage();
    return kExitUsage;
  }

  const std::string request_json = read_text_file(context.request_path);
  context.request = parse_request(request_json);
  if (context.artifact_root.empty()) {
    context.artifact_root = context.request.artifact_root.empty()
                                ? std::filesystem::path(".build/devtools-driver-capability-probe") /
                                      context.request.execution_id
                                : std::filesystem::path(context.request.artifact_root);
  }
  context.requested_video_codec = context.request.video_codec;
  context.output_consumer = context.request.output_consumer;
  context.bootstrap_id = context.request.bootstrap_id;
  context.bootstrap_path = context.request.bootstrap_path;
  std::filesystem::create_directories(context.artifact_root);
  context.events.open(context.artifact_root / "events.jsonl");
  context.log.open(context.artifact_root / "driver.log");

  std::string preflight_reason;
  if (!validate_preflight(&context, request_json, &preflight_reason)) {
    context.status = "failed";
    context.exit_code = kExitPreflight;
    context.reason_code = preflight_reason;
    (void)write_summary(&context);
    return context.exit_code;
  }

  const bool device_role = context.request.role == "device" || context.request.role == "send";
  const bool ok = device_role ? run_send_role(&context) : run_receive_role(&context);
  if (!ok) {
    context.status = "failed";
    context.exit_code = kExitRoleFailed;
    if (context.reason_code.empty()) {
      context.reason_code = (context.request.role == "client" || context.request.role == "receive")
                                ? "output_sink_unavailable"
                                : "media_send_timeout";
    }
  } else {
    context.status = "completed";
    context.exit_code = 0;
    if (context.ready_at.empty()) {
      context.ready_at = now_rfc3339();
    }
    if (context.stop_reason.empty()) {
      context.stop_reason = "driver_complete";
    }
  }
  emit_event(&context, context.exit_code == 0 ? "info" : "error", "artifact",
             "driver.execution.finished",
             "{\"status\":\"" + context.status +
                 "\",\"exit_code\":" + std::to_string(context.exit_code) + ",\"reason_code\":\"" +
                 (context.reason_code.empty() ? "ok" : json_escape(context.reason_code)) + "\"}");
  if (!write_summary(&context)) {
    return kExitRoleFailed;
  }
  return context.exit_code;
}
