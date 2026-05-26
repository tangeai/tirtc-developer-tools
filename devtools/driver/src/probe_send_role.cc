#include <algorithm>
#include <chrono>
#include <cstddef>
#include <ctime>
#include <limits>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>
#include <vector>

#include "probe_role_helpers.h"
#include "probe_send_session.h"

namespace devtools_driver_probe {
namespace {

constexpr int kMaxDeviceConnections = 4;
constexpr uint32_t kProbeVideoWidth = 1280;
constexpr uint32_t kProbeVideoHeight = 720;
constexpr int64_t kNoPacketPtsUs = std::numeric_limits<int64_t>::max();
constexpr auto kConnectionPollInterval = std::chrono::milliseconds(20);
constexpr auto kStreamMessagePeriod = std::chrono::seconds(10);
constexpr auto kStreamMessageRetryDelay = std::chrono::milliseconds(250);
constexpr int kStreamMessageMinPeriodMs = 8000;
constexpr int kStreamMessageMaxPeriodMs = 12000;

struct SendInputLifecycle {
  TirtcAudioEncodedInput* audio_input = nullptr;
  TirtcVideoEncodedInput* video_input = nullptr;
  bool audio_input_started = false;
  bool video_input_started = false;

  void stop() {
    if (video_input_started) {
      (void)tirtc_video_encoded_input_stop(video_input);
      video_input_started = false;
    }
    if (audio_input_started) {
      (void)tirtc_audio_encoded_input_stop(audio_input);
      audio_input_started = false;
    }
  }

  void cleanup() {
    stop();
    if (video_input != nullptr) {
      tirtc_video_encoded_input_destroy(video_input);
      video_input = nullptr;
    }
    if (audio_input != nullptr) {
      tirtc_audio_encoded_input_destroy(audio_input);
      audio_input = nullptr;
    }
  }
};

struct ActiveSendSession {
  TirtcConn* connection = nullptr;
  ConnectionEvents events;
  ConnCallbackContext callback_context;
  int session_index = 0;
  bool audio_attached = false;
  bool video_attached = false;
  bool sent_first_audio = false;
  bool sent_first_video = false;
  bool sent_first_stream_message = false;
  std::chrono::steady_clock::time_point next_stream_message_send_at{};
  std::chrono::steady_clock::time_point first_packet_deadline{};
};

bool take_next_connection(ServiceContext* service_context, TirtcConn** out_connection) {
  std::lock_guard<std::mutex> guard(service_context->connections_lock);
  if (service_context->accepted_connections.empty()) {
    *out_connection = nullptr;
    return false;
  }
  *out_connection = service_context->accepted_connections.front();
  service_context->accepted_connections.pop_front();
  return true;
}

int64_t next_cycle_packet_pts_us(const std::vector<PacketEntry>& packets, size_t index,
                                 int64_t cycle_duration_us) {
  if (index >= packets.size()) {
    return kNoPacketPtsUs;
  }
  const int64_t pts_us = packets[index].pts_us;
  return pts_us < cycle_duration_us ? pts_us : kNoPacketPtsUs;
}

bool is_transient_transport_send_error(TirtcError status) {
  return status == TIRTC_ERROR_TRANSPORT_INVALID_HANDLE || status == TIRTC_ERROR_TRANSPORT_BUSY ||
         status == TIRTC_ERROR_NOT_CONNECTED || status == TIRTC_ERROR_TRANSPORT_TIMEOUT ||
         status == TIRTC_ERROR_TRANSPORT_BACKEND_CONNECTION_OTHER_ERROR;
}

void emit_session_first_audio(DriverContext* context, int session_index, int64_t pts_us,
                              const PacketEntry& packet, size_t bytes) {
  (void)emit_event(
      context, "info", "media", "media.audio_send.session_first_packet",
      "{\"session_index\":" + std::to_string(session_index) +
          ",\"stream_id\":" + std::to_string(static_cast<int>(context->request.audio_stream_id)) +
          ",\"audio_codec\":\"" + json_escape(context->request.audio_codec) +
          "\",\"sample_rate_hz\":" + std::to_string(context->request.audio_sample_rate_hz) +
          ",\"channels\":" + std::to_string(context->request.audio_channels) +
          ",\"bits_per_sample\":" + std::to_string(kAudioBitsPerSample) +
          ",\"audio_asset_key\":\"" + json_escape(context->audio_asset_key) +
          "\",\"samples_per_channel\":" + std::to_string(packet.samples_per_channel) +
          ",\"pts_us\":" + std::to_string(pts_us) + ",\"bytes\":" + std::to_string(bytes) + "}");
  if (context->first_audio_packet_ms >= 0) {
    return;
  }
  context->first_audio_packet_ms = elapsed_ms_since_start(context);
  (void)emit_event(
      context, "info", "media", "media.audio_send.first_packet",
      "{\"session_index\":" + std::to_string(session_index) +
          ",\"stream_id\":" + std::to_string(static_cast<int>(context->request.audio_stream_id)) +
          ",\"audio_codec\":\"" + json_escape(context->request.audio_codec) +
          "\",\"sample_rate_hz\":" + std::to_string(context->request.audio_sample_rate_hz) +
          ",\"channels\":" + std::to_string(context->request.audio_channels) +
          ",\"bits_per_sample\":" + std::to_string(kAudioBitsPerSample) +
          ",\"audio_asset_key\":\"" + json_escape(context->audio_asset_key) +
          "\",\"samples_per_channel\":" + std::to_string(packet.samples_per_channel) +
          ",\"pts_us\":" + std::to_string(pts_us) + ",\"bytes\":" + std::to_string(bytes) + "}");
}

std::string emit_session_first_video(DriverContext* context, int session_index,
                                     const std::string& codec, int64_t pts_us, size_t bytes,
                                     bool is_key_frame) {
  const std::string payload =
      "{\"session_index\":" + std::to_string(session_index) +
      ",\"stream_id\":" + std::to_string(static_cast<int>(context->request.video_stream_id)) +
      ",\"codec\":\"" + json_escape(codec) + "\",\"pts_us\":" + std::to_string(pts_us) +
      ",\"bytes\":" + std::to_string(bytes) +
      ",\"is_key_frame\":" + (is_key_frame ? "true" : "false") + "}";
  (void)emit_event(context, "info", "media", "media.video_send.session_first_packet", payload);
  if (context->first_video_packet_ms >= 0) {
    return "";
  }
  context->first_video_packet_ms = elapsed_ms_since_start(context);
  if (is_key_frame && context->first_key_frame_ms < 0) {
    context->first_key_frame_ms = context->first_video_packet_ms;
  }
  return emit_event(context, "info", "media", "media.video_send.first_packet", payload);
}

void cleanup_pending_connections(ServiceContext* service_context) {
  for (;;) {
    TirtcConn* connection = nullptr;
    if (!take_next_connection(service_context, &connection)) {
      return;
    }
    if (connection != nullptr) {
      (void)tirtc_conn_set_callbacks(connection, nullptr, nullptr);
      tirtc_conn_destroy(connection);
    }
  }
}

void cleanup_active_session(DriverContext* context, SendInputLifecycle* inputs,
                            ActiveSendSession* session, const std::string& exit_reason,
                            const std::string& submit_error_track, int submit_error_status) {
  if (session == nullptr) {
    return;
  }
  if (inputs != nullptr && session->video_attached) {
    (void)tirtc_video_encoded_input_detach(inputs->video_input, session->connection);
    session->video_attached = false;
  }
  if (inputs != nullptr && session->audio_attached) {
    (void)tirtc_audio_encoded_input_detach(inputs->audio_input, session->connection);
    session->audio_attached = false;
  }
  if (session->connection != nullptr) {
    (void)tirtc_conn_set_callbacks(session->connection, nullptr, nullptr);
  }

  const bool disconnected = session->events.disconnected.load() != 0;
  if (disconnected && session->sent_first_stream_message) {
    std::lock_guard<std::mutex> guard(context->stream_message_lock);
    context->stream_message_stopped_after_disconnect = true;
  }
  (void)emit_event(context, "info", "connection", "connection.session.end",
                   "{\"session_index\":" + std::to_string(session->session_index) +
                       ",\"sent_first_audio\":" + (session->sent_first_audio ? "true" : "false") +
                       ",\"sent_first_video\":" + (session->sent_first_video ? "true" : "false") +
                       ",\"disconnected\":" + (disconnected ? "true" : "false") +
                       ",\"exit_reason\":\"" + json_escape(exit_reason) +
                       "\",\"submit_error_track\":\"" + json_escape(submit_error_track) +
                       "\",\"submit_error_status\":" + std::to_string(submit_error_status) +
                       ",\"elapsed_ms\":" + std::to_string(elapsed_ms_since_start(context)) + "}");

  const bool service_owned_active =
      !disconnected && (exit_reason == "service_stopped" || exit_reason == "device_deadline" ||
                        exit_reason == "stop_requested");
  if (session->connection != nullptr && !service_owned_active) {
    tirtc_conn_destroy(session->connection);
  }
  session->connection = nullptr;
}

void cleanup_active_sessions(DriverContext* context, SendInputLifecycle* inputs,
                             std::vector<std::unique_ptr<ActiveSendSession>>* active_sessions,
                             const std::string& exit_reason,
                             const std::string& submit_error_track = "",
                             int submit_error_status = static_cast<int>(TIRTC_ERROR_OK)) {
  if (active_sessions == nullptr) {
    return;
  }
  for (const auto& session : *active_sessions) {
    cleanup_active_session(context, inputs, session.get(), exit_reason, submit_error_track,
                           submit_error_status);
  }
  active_sessions->clear();
}

bool cleanup_finished_sessions(DriverContext* context, SendInputLifecycle* inputs,
                               std::vector<std::unique_ptr<ActiveSendSession>>* active_sessions) {
  bool removed = false;
  for (auto iterator = active_sessions->begin(); iterator != active_sessions->end();) {
    ActiveSendSession* session = iterator->get();
    if (session->events.disconnected.load() == 0 && session->events.errors.load() == 0) {
      ++iterator;
      continue;
    }
    const std::string exit_reason =
        session->events.disconnected.load() != 0 ? "connection_disconnected" : "connection_error";
    cleanup_active_session(context, inputs, session, exit_reason, "",
                           static_cast<int>(TIRTC_ERROR_OK));
    iterator = active_sessions->erase(iterator);
    removed = true;
  }
  return removed;
}

bool start_shared_inputs(DriverContext* context, const SendAssets& assets,
                         SendInputLifecycle* inputs, std::string* reason_code,
                         std::string* event_kind) {
  if (tirtc_audio_encoded_input_create(&inputs->audio_input) != TIRTC_ERROR_OK ||
      inputs->audio_input == nullptr ||
      tirtc_audio_encoded_input_set_options(inputs->audio_input, &assets.audio_options) !=
          TIRTC_ERROR_OK) {
    *reason_code = "media_send_failed";
    *event_kind = "media.audio_send.failed";
    inputs->cleanup();
    return false;
  }
  if (tirtc_video_encoded_input_create(&inputs->video_input) != TIRTC_ERROR_OK ||
      inputs->video_input == nullptr ||
      tirtc_video_encoded_input_set_options(inputs->video_input, &assets.video_options) !=
          TIRTC_ERROR_OK) {
    *reason_code = "codec_unsupported";
    *event_kind = "media.video_send.failed";
    inputs->cleanup();
    return false;
  }
  if (tirtc_audio_encoded_input_start(inputs->audio_input) != TIRTC_ERROR_OK) {
    *reason_code = "media_send_failed";
    *event_kind = "media.audio_send.failed";
    inputs->cleanup();
    return false;
  }
  inputs->audio_input_started = true;
  if (tirtc_video_encoded_input_start(inputs->video_input) != TIRTC_ERROR_OK) {
    *reason_code = "codec_unsupported";
    *event_kind = "media.video_send.failed";
    inputs->cleanup();
    return false;
  }
  inputs->video_input_started = true;
  return true;
}

int64_t current_epoch_seconds() {
  const auto now = std::chrono::system_clock::now();
  return static_cast<int64_t>(std::chrono::system_clock::to_time_t(now));
}

void send_stream_message_for_session(DriverContext* context, ActiveSendSession* session) {
  if (context == nullptr || session == nullptr || session->connection == nullptr) {
    return;
  }
  const int64_t payload_epoch_seconds = current_epoch_seconds();
  const std::string payload = std::to_string(payload_epoch_seconds);
  const std::string payload_hash = fnv1a64_hex(payload.data(), payload.size());
  TirtcStreamMessage message{};
  message.timestamp_ms = 0;
  message.data = payload.data();
  message.length = payload.size();
  const TirtcError send_result = tirtc_conn_send_stream_message(
      session->connection, context->request.video_stream_id, &message);
  const int event_monotonic_ms = elapsed_ms_since_start(context);
  const bool ok = send_result == TIRTC_ERROR_OK;
  if (!ok && is_transient_transport_send_error(send_result)) {
    session->next_stream_message_send_at =
        std::chrono::steady_clock::now() + kStreamMessageRetryDelay;
    return;
  }

  if (ok) {
    context->stream_message_sent.fetch_add(1);
  } else {
    context->stream_message_errors.fetch_add(1);
  }
  {
    std::lock_guard<std::mutex> guard(context->stream_message_lock);
    context->stream_message_last_session_index = session->session_index;
    context->stream_message_last_payload_epoch_seconds = payload_epoch_seconds;
    context->stream_message_has_last_payload = true;
    context->stream_message_last_payload_bytes = payload.size();
    context->stream_message_last_payload_hash = payload_hash;
    context->stream_message_last_send_result = static_cast<int>(send_result);
    if (ok) {
      if (context->stream_message_first_send_monotonic_ms < 0) {
        context->stream_message_first_send_monotonic_ms = event_monotonic_ms;
      }
      if (context->stream_message_last_send_monotonic_ms >= 0) {
        const int interval_ms = event_monotonic_ms - context->stream_message_last_send_monotonic_ms;
        if (interval_ms >= kStreamMessageMinPeriodMs && interval_ms <= kStreamMessageMaxPeriodMs) {
          context->stream_message_periodic_send_ok = true;
        }
        context->stream_message_previous_send_monotonic_ms =
            context->stream_message_last_send_monotonic_ms;
      }
      context->stream_message_last_send_monotonic_ms = event_monotonic_ms;
    }
  }

  (void)emit_event(
      context, ok ? "info" : "error", "stream_message",
      ok ? "stream_message.send.done" : "stream_message.send.failed",
      "{\"pairing_id\":\"" + json_escape(context->request.pairing_id) +
          "\",\"session_index\":" + std::to_string(session->session_index) +
          ",\"stream_id\":" + std::to_string(static_cast<int>(context->request.video_stream_id)) +
          ",\"payload_epoch_seconds\":" + std::to_string(payload_epoch_seconds) +
          ",\"payload_bytes\":" + std::to_string(payload.size()) + ",\"payload_hash\":\"" +
          json_escape(payload_hash) +
          "\",\"event_monotonic_ms\":" + std::to_string(event_monotonic_ms) +
          ",\"send_result\":" + std::to_string(static_cast<int>(send_result)) + "}");
  session->sent_first_stream_message = true;
  session->next_stream_message_send_at = std::chrono::steady_clock::now() + kStreamMessagePeriod;
}

bool attach_active_session(DriverContext* context, SendInputLifecycle* inputs,
                           const SendAssets& assets, TirtcConn* connection, int session_index,
                           std::vector<std::unique_ptr<ActiveSendSession>>* active_sessions,
                           std::string* reason_code, std::string* event_kind) {
  auto session = std::make_unique<ActiveSendSession>();
  session->connection = connection;
  session->session_index = session_index;
  session->callback_context.driver_context = context;
  session->callback_context.connection_events = &session->events;
  session->callback_context.session_index = session_index;
  session->first_packet_deadline =
      std::chrono::steady_clock::now() +
      std::chrono::milliseconds(context->request.first_packet_timeout_ms);

  TirtcConnCallbacks conn_callbacks{};
  conn_callbacks.on_state_changed = on_conn_state_changed;
  conn_callbacks.on_command = on_conn_command_echo;
  conn_callbacks.on_stream_message = on_conn_stream_message;
  if (tirtc_conn_set_callbacks(connection, &conn_callbacks, &session->callback_context) !=
      TIRTC_ERROR_OK) {
    *reason_code = "media_send_failed";
    *event_kind = "media.audio_send.failed";
    tirtc_conn_destroy(connection);
    return false;
  }

  (void)emit_event(context, "info", "connection", "connection.session.start",
                   "{\"session_index\":" + std::to_string(session_index) + ",\"remote_id\":\"" +
                       json_escape(context->request.remote_id) + "\",\"elapsed_ms\":" +
                       std::to_string(elapsed_ms_since_start(context)) + "}");

  if (tirtc_audio_encoded_input_attach(inputs->audio_input, connection,
                                       context->request.audio_stream_id) != TIRTC_ERROR_OK) {
    *reason_code = "media_send_failed";
    *event_kind = "media.audio_send.failed";
    cleanup_active_session(context, inputs, session.get(), "audio_attach_failed", "",
                           static_cast<int>(TIRTC_ERROR_OK));
    return false;
  }
  session->audio_attached = true;
  if (tirtc_video_encoded_input_attach(inputs->video_input, connection,
                                       context->request.video_stream_id) != TIRTC_ERROR_OK) {
    *reason_code = "codec_unsupported";
    *event_kind = "media.video_send.failed";
    cleanup_active_session(context, inputs, session.get(), "video_attach_failed", "",
                           static_cast<int>(TIRTC_ERROR_OK));
    return false;
  }
  session->video_attached = true;

  (void)emit_event(
      context, "info", "media", "media.audio_send.start",
      "{\"session_index\":" + std::to_string(session_index) +
          ",\"stream_id\":" + std::to_string(static_cast<int>(context->request.audio_stream_id)) +
          ",\"audio_codec\":\"" + json_escape(context->request.audio_codec) +
          "\",\"sample_rate_hz\":" + std::to_string(context->request.audio_sample_rate_hz) +
          ",\"channels\":" + std::to_string(context->request.audio_channels) +
          ",\"bits_per_sample\":" + std::to_string(kAudioBitsPerSample) +
          ",\"audio_asset_key\":\"" + json_escape(context->audio_asset_key) + "\"}");
  (void)emit_event(context, "info", "media", "media.video_send.start",
                   "{\"session_index\":" + std::to_string(session_index) + ",\"stream_id\":" +
                       std::to_string(static_cast<int>(context->request.video_stream_id)) +
                       ",\"codec\":\"" + json_escape(context->request.video_codec) + "\"}");
  (void)emit_event(context, "info", "media", "media.asset_cycle.config",
                   "{\"session_index\":" + std::to_string(session_index) +
                       ",\"audio_packet_count\":" + std::to_string(assets.audio_packets.size()) +
                       ",\"video_packet_count\":" + std::to_string(assets.video_packets.size()) +
                       ",\"audio_duration_us\":" + std::to_string(assets.audio_track_duration_us) +
                       ",\"video_duration_us\":" + std::to_string(assets.video_track_duration_us) +
                       ",\"cycle_duration_us\":" + std::to_string(assets.asset_cycle_duration_us) +
                       ",\"duration_ms\":" + std::to_string(context->request.duration_ms) + "}");

  send_stream_message_for_session(context, session.get());
  active_sessions->push_back(std::move(session));
  return true;
}

bool fail_send_role(DriverContext* context, TirtcConnService* service, const std::string& stage,
                    const std::string& reason_code, const std::string& family,
                    const std::string& event_kind, const std::string& payload) {
  context->reason_code = reason_code;
  const std::string event_id = emit_event(context, "error", family, event_kind, payload);
  finish_stage(context, stage, StageResult::Failed, reason_code, event_id);
  if (service != nullptr) {
    (void)tirtc_conn_service_stop(service);
  }
  (void)upload_logs_on_failure(context);
  tirtc_uninit();
  return false;
}

}  // namespace

bool run_send_role(DriverContext* context) {
  start_stage(context, "endpoint");
  const std::string log_root_dir = (context->artifact_root / "runtime-log").string();
  TirtcInitOptions init_options{};
  init_options.app_id = context->request.app_id.empty() ? nullptr : context->request.app_id.c_str();
  init_options.endpoint = context->request.endpoint.c_str();
  init_options.log_root_dir = log_root_dir.c_str();
  init_options.console_log_enabled = 1;
  if (tirtc_init(&init_options) != TIRTC_ERROR_OK) {
    context->reason_code = "endpoint_init_failed";
    const std::string event_id =
        emit_event(context, "error", "endpoint", "endpoint.init.failed",
                   "{\"reason_code\":\"endpoint_init_failed\",\"detail\":\"tirtc_init failed\"}");
    finish_stage(context, "endpoint", StageResult::Failed, "endpoint_init_failed", event_id);
    return false;
  }
  finish_stage(context, "endpoint", StageResult::Passed, "ok", "");

  ServiceContext service_context{};
  TirtcConnService* service = nullptr;
  TirtcConnServiceCallbacks callbacks{};
  callbacks.on_started = on_service_started;
  callbacks.on_stopped = on_service_stopped;
  callbacks.on_connected = on_service_connected;
  callbacks.on_error = on_service_error;

  start_stage(context, "connect");
  TirtcConnServiceStartOptions start_options{};
  start_options.device_id = context->request.remote_id.c_str();
  start_options.device_secret_key = context->request.device_secret_key.c_str();
  start_options.max_connections = kMaxDeviceConnections;
  if (tirtc_conn_service_start(&start_options, &callbacks, &service_context, &service) !=
          TIRTC_ERROR_OK ||
      service == nullptr) {
    return fail_send_role(context, service, "connect", "connect_failed", "connection",
                          "connection.connect.failed",
                          "{\"remote_id\":\"" + json_escape(context->request.remote_id) +
                              "\",\"reason_code\":\"connect_failed\",\"elapsed_ms\":0}");
  }
  if (!wait_until(context->request.connect_timeout_ms,
                  [&]() { return service_context.started.load() != 0; })) {
    return fail_send_role(context, service, "connect", "connect_timeout", "connection",
                          "connection.connect.failed",
                          "{\"remote_id\":\"" + json_escape(context->request.remote_id) +
                              "\",\"reason_code\":\"connect_timeout\",\"elapsed_ms\":" +
                              std::to_string(context->request.connect_timeout_ms) + "}");
  }

  const auto service_started_at = std::chrono::steady_clock::now();
  const bool has_device_deadline = context->request.duration_ms > 0;
  const auto device_deadline =
      service_started_at + std::chrono::milliseconds(context->request.duration_ms);
  const std::string listen_event = emit_event(
      context, "info", "connection", "connection.listen.done",
      "{\"remote_id\":\"" + json_escape(context->request.remote_id) + "\",\"elapsed_ms\":0}");
  finish_stage(context, "connect", StageResult::Passed, "ok", listen_event);

  if (!context->request.token.empty()) {
    start_stage(context, "bootstrap");
    context->bootstrap_id = context->request.execution_id + "-bootstrap";
    context->bootstrap_path = (context->artifact_root / "bootstrap.json").string();
    std::ostringstream bootstrap;
    bootstrap << "{\n"
              << "  \"schema_version\": 1,\n"
              << "  \"bootstrap_id\": \"" << json_escape(context->bootstrap_id) << "\",\n"
              << "  \"execution_id\": \"" << json_escape(context->request.execution_id) << "\",\n"
              << "  \"pairing_id\": \"" << json_escape(context->request.pairing_id) << "\",\n"
              << "  \"created_at\": \"" << now_rfc3339() << "\",\n"
              << "  \"producer\": \"cli_device\",\n"
              << "  \"app_id\": \"" << json_escape(context->request.app_id) << "\",\n"
              << "  \"endpoint\": \"" << json_escape(context->request.endpoint) << "\",\n"
              << "  \"device_id\": \"" << json_escape(context->request.remote_id) << "\",\n"
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
      cleanup_pending_connections(&service_context);
      (void)tirtc_conn_service_stop(service);
      (void)upload_logs_on_failure(context);
      tirtc_uninit();
      return false;
    }
    const std::string bootstrap_event =
        emit_event(context, "info", "bootstrap", "bootstrap.write.done",
                   "{\"bootstrap_id\":\"" + json_escape(context->bootstrap_id) + "\",\"path\":\"" +
                       json_escape(context->bootstrap_path) + "\",\"device_id\":\"" +
                       json_escape(context->request.remote_id) + "\",\"audio_stream_id\":" +
                       std::to_string(static_cast<int>(context->request.audio_stream_id)) +
                       ",\"video_stream_id\":" +
                       std::to_string(static_cast<int>(context->request.video_stream_id)) + "}");
    finish_stage(context, "bootstrap", StageResult::Passed, "ok", bootstrap_event);
  }

  SendAssets assets{};
  SendInputLifecycle inputs{};
  std::vector<std::unique_ptr<ActiveSendSession>> active_sessions;
  bool assets_prepared = false;
  bool inputs_started = false;
  bool media_stage_started = false;
  bool media_stage_finished = false;
  bool accepted_any_session = false;
  int session_index = 0;
  size_t audio_packet_index = 0;
  size_t video_packet_index = 0;
  int64_t cycle_offset_us = 0;
  auto media_started_at = std::chrono::steady_clock::now();

  auto reset_media_timeline = [&]() {
    audio_packet_index = 0;
    video_packet_index = 0;
    cycle_offset_us = 0;
    media_started_at = std::chrono::steady_clock::now();
  };

  auto fail_media_send = [&](const std::string& reason_code, const std::string& event_kind,
                             const std::string& track, int submit_error_status) -> bool {
    context->reason_code = reason_code;
    const std::string event_id =
        emit_event(context, "error", "media", event_kind,
                   "{\"reason_code\":\"" + json_escape(reason_code) + "\",\"codec\":\"" +
                       json_escape(context->request.video_codec) + "\",\"submit_error_track\":\"" +
                       json_escape(track) +
                       "\",\"submit_error_status\":" + std::to_string(submit_error_status) + "}");
    if (!media_stage_finished) {
      finish_stage(context, "media_send", StageResult::Failed, reason_code, event_id);
    }
    inputs.stop();
    (void)tirtc_conn_service_stop(service);
    cleanup_active_sessions(context, &inputs, &active_sessions, reason_code, track,
                            submit_error_status);
    inputs.cleanup();
    cleanup_pending_connections(&service_context);
    (void)upload_logs_on_failure(context);
    tirtc_uninit();
    return false;
  };

  auto ensure_media_ready = [&]() -> bool {
    if (!assets_prepared) {
      std::string reason_code;
      std::string event_kind;
      if (!prepare_send_assets(context, &assets, &reason_code, &event_kind)) {
        return fail_media_send(reason_code, event_kind, "", static_cast<int>(TIRTC_ERROR_OK));
      }
      assets_prepared = true;
    }
    if (!media_stage_started) {
      start_stage(context, "media_send");
      media_stage_started = true;
    }
    if (!inputs_started) {
      std::string reason_code;
      std::string event_kind;
      if (!start_shared_inputs(context, assets, &inputs, &reason_code, &event_kind)) {
        return fail_media_send(reason_code, event_kind, "", static_cast<int>(TIRTC_ERROR_OK));
      }
      inputs_started = true;
    }
    return true;
  };

  auto accept_pending_connections = [&]() -> bool {
    for (;;) {
      TirtcConn* connection = nullptr;
      if (!take_next_connection(&service_context, &connection)) {
        break;
      }
      if (connection == nullptr) {
        continue;
      }
      if (!ensure_media_ready()) {
        return false;
      }
      if (active_sessions.empty()) {
        reset_media_timeline();
      }
      session_index += 1;
      (void)emit_event(context, "info", "connection", "connection.connect.done",
                       "{\"session_index\":" + std::to_string(session_index) + ",\"remote_id\":\"" +
                           json_escape(context->request.remote_id) + "\",\"active_sessions\":" +
                           std::to_string(active_sessions.size() + 1) + ",\"elapsed_ms\":0}");

      std::string reason_code;
      std::string event_kind;
      if (!attach_active_session(context, &inputs, assets, connection, session_index,
                                 &active_sessions, &reason_code, &event_kind)) {
        return fail_media_send(reason_code, event_kind, "", static_cast<int>(TIRTC_ERROR_OK));
      }
      accepted_any_session = true;
    }
    return true;
  };

  while (g_stop_requested.load() == 0 && service_context.errors.load() == 0 &&
         service_context.stopped.load() == 0 &&
         (!has_device_deadline || std::chrono::steady_clock::now() < device_deadline)) {
    if (!accept_pending_connections()) {
      return false;
    }
    drain_pending_command_echoes(context);
    (void)cleanup_finished_sessions(context, &inputs, &active_sessions);

    if (context->request.exit_after_first_session && accepted_any_session &&
        active_sessions.empty() && context->first_audio_packet_ms >= 0 &&
        context->first_video_packet_ms >= 0) {
      break;
    }

    if (active_sessions.empty()) {
      if (has_device_deadline && std::chrono::steady_clock::now() >= device_deadline) {
        break;
      }
      std::this_thread::sleep_for(kConnectionPollInterval);
      continue;
    }

    const auto now = std::chrono::steady_clock::now();
    for (const auto& session : active_sessions) {
      if ((!session->sent_first_audio || !session->sent_first_video) &&
          now >= session->first_packet_deadline) {
        return fail_media_send("media_send_timeout", "media.send.failed", "",
                               static_cast<int>(TIRTC_ERROR_OK));
      }
    }

    const int64_t audio_cycle_pts_us = next_cycle_packet_pts_us(
        assets.audio_packets, audio_packet_index, assets.asset_cycle_duration_us);
    const int64_t video_cycle_pts_us = next_cycle_packet_pts_us(
        assets.video_packets, video_packet_index, assets.asset_cycle_duration_us);
    const int64_t next_packet_cycle_pts_us = std::min(audio_cycle_pts_us, video_cycle_pts_us);
    const bool has_next_packet = next_packet_cycle_pts_us != kNoPacketPtsUs;
    const bool send_audio_next = audio_cycle_pts_us <= video_cycle_pts_us;
    const int64_t target_pts_us =
        cycle_offset_us +
        (has_next_packet ? next_packet_cycle_pts_us : assets.asset_cycle_duration_us);
    const auto target_time = media_started_at + std::chrono::microseconds(target_pts_us);
    if (has_device_deadline && target_time > device_deadline) {
      break;
    }

    while (target_time > std::chrono::steady_clock::now() && g_stop_requested.load() == 0 &&
           service_context.errors.load() == 0 && service_context.stopped.load() == 0) {
      if (!accept_pending_connections()) {
        return false;
      }
      drain_pending_command_echoes(context);
      (void)cleanup_finished_sessions(context, &inputs, &active_sessions);
      std::this_thread::sleep_until(
          std::min(target_time, std::chrono::steady_clock::now() + kConnectionPollInterval));
    }
    if (g_stop_requested.load() != 0 || service_context.errors.load() != 0 ||
        service_context.stopped.load() != 0) {
      break;
    }
    if (!accept_pending_connections()) {
      return false;
    }
    drain_pending_command_echoes(context);
    (void)cleanup_finished_sessions(context, &inputs, &active_sessions);
    if (context->request.exit_after_first_session && accepted_any_session &&
        active_sessions.empty() && context->first_audio_packet_ms >= 0 &&
        context->first_video_packet_ms >= 0) {
      break;
    }
    if (active_sessions.empty()) {
      continue;
    }

    const auto stream_message_now = std::chrono::steady_clock::now();
    for (const auto& session : active_sessions) {
      if (session->next_stream_message_send_at != std::chrono::steady_clock::time_point{} &&
          stream_message_now >= session->next_stream_message_send_at) {
        send_stream_message_for_session(context, session.get());
      }
    }

    if (!has_next_packet) {
      audio_packet_index = 0;
      video_packet_index = 0;
      cycle_offset_us += assets.asset_cycle_duration_us;
      continue;
    }

    if (send_audio_next) {
      const PacketEntry& audio_packet = assets.audio_packets[audio_packet_index];
      const int64_t audio_pts_us = audio_packet.pts_us + cycle_offset_us;
      auto payload = read_packet_bytes(assets.audio_path, audio_packet);
      if (payload.empty()) {
        return fail_media_send("media_send_failed", "media.audio_send.failed", "",
                               static_cast<int>(TIRTC_ERROR_OK));
      }
      TirtcAudioEncodedInputFrame frame{};
      frame.codec = assets.audio_options.codec;
      frame.sample_rate_hz = assets.audio_options.sample_rate_hz;
      frame.channels = assets.audio_options.channels;
      frame.samples_per_channel = audio_packet.samples_per_channel;
      frame.pts_us = audio_pts_us;
      frame.data = payload.data();
      frame.data_bytes = payload.size();
      const TirtcError submit_status =
          tirtc_audio_encoded_input_submit_frame(inputs.audio_input, &frame);
      if (submit_status != TIRTC_ERROR_OK) {
        if (is_transient_transport_send_error(submit_status)) {
          audio_packet_index += 1;
          continue;
        }
        return fail_media_send("media_send_failed", "media.audio_send.failed", "audio",
                               static_cast<int>(submit_status));
      }
      context->audio_packet_count += 1;
      context->audio_bytes += payload.size();
      for (const auto& session : active_sessions) {
        if (!session->sent_first_audio) {
          session->sent_first_audio = true;
          emit_session_first_audio(context, session->session_index, audio_pts_us, audio_packet,
                                   payload.size());
        }
      }
      audio_packet_index += 1;
    } else {
      const PacketEntry& video_packet = assets.video_packets[video_packet_index];
      const int64_t video_pts_us = video_packet.pts_us + cycle_offset_us;
      auto payload = read_packet_bytes(assets.video_path, video_packet);
      if (payload.empty()) {
        return fail_media_send("codec_unsupported", "media.video_send.failed", "",
                               static_cast<int>(TIRTC_ERROR_OK));
      }
      TirtcVideoEncodedFrame frame{};
      frame.codec = assets.video_options.codec;
      frame.bitstream_format = assets.video_options.bitstream_format;
      frame.width = kProbeVideoWidth;
      frame.height = kProbeVideoHeight;
      frame.pts_us = video_pts_us;
      frame.is_key_frame = video_packet.is_key_frame ? 1 : 0;
      frame.data = payload.data();
      frame.data_bytes = payload.size();
      const TirtcError submit_status =
          tirtc_video_encoded_input_submit_frame(inputs.video_input, &frame);
      if (submit_status != TIRTC_ERROR_OK) {
        if (is_transient_transport_send_error(submit_status)) {
          video_packet_index += 1;
          continue;
        }
        return fail_media_send("codec_unsupported", "media.video_send.failed", "video",
                               static_cast<int>(submit_status));
      }
      std::string first_packet_event_id;
      context->video_packet_count += 1;
      context->video_bytes += payload.size();
      if (video_packet.is_key_frame) {
        for (const auto& session : active_sessions) {
          if (!session->sent_first_video) {
            session->sent_first_video = true;
            const std::string event_id = emit_session_first_video(
                context, session->session_index, context->request.video_codec, video_pts_us,
                payload.size(), true);
            if (!event_id.empty()) {
              first_packet_event_id = event_id;
            }
          }
        }
      }
      video_packet_index += 1;
      if (!media_stage_finished && context->first_audio_packet_ms >= 0 &&
          context->first_video_packet_ms >= 0) {
        finish_stage(context, "media_send", StageResult::Passed, "ok", first_packet_event_id);
        media_stage_finished = true;
      }
    }
  }

  if (!accepted_any_session &&
      (service_context.errors.load() != 0 || service_context.stopped.load() != 0)) {
    return fail_send_role(context, service, "connect", "connect_failed", "connection",
                          "connection.connect.failed",
                          "{\"remote_id\":\"" + json_escape(context->request.remote_id) +
                              "\",\"reason_code\":\"connect_failed\",\"elapsed_ms\":" +
                              std::to_string(elapsed_ms_since_start(context)) + "}");
  }

  if (!accepted_any_session) {
    const std::string stop_reason = g_stop_requested.load() != 0 ? "signal" : "duration_elapsed";
    const std::string event_id = emit_event(
        context, "info", "connection", "connection.wait.no_client",
        "{\"reason\":\"" + stop_reason +
            "\",\"elapsed_ms\":" + std::to_string(elapsed_ms_since_start(context)) + "}");
    start_stage(context, "media_send");
    finish_stage(context, "media_send", StageResult::Skipped, "no_client_connected", event_id);
  }

  const std::string exit_reason =
      g_stop_requested.load() != 0
          ? "stop_requested"
          : (has_device_deadline && std::chrono::steady_clock::now() >= device_deadline
                 ? "device_deadline"
                 : "service_stopped");
  drain_pending_command_echoes(context);
  inputs.stop();
  (void)emit_event(
      context, "info", "media", "media.audio_send.summary",
      "{\"role\":\"device\",\"stream_id\":" +
          std::to_string(static_cast<int>(context->request.audio_stream_id)) +
          ",\"audio_codec\":\"" + json_escape(context->request.audio_codec) +
          "\",\"sample_rate_hz\":" + std::to_string(context->request.audio_sample_rate_hz) +
          ",\"channels\":" + std::to_string(context->request.audio_channels) +
          ",\"bits_per_sample\":" + std::to_string(kAudioBitsPerSample) +
          ",\"audio_asset_key\":\"" + json_escape(context->audio_asset_key) +
          "\",\"audio_packet_count\":" + std::to_string(context->audio_packet_count) +
          ",\"audio_bytes\":" + std::to_string(context->audio_bytes) +
          ",\"first_audio_packet_ms\":" + std::to_string(context->first_audio_packet_ms) +
          ",\"status\":\"" + (context->audio_packet_count > 0 ? "passed" : "failed") + "\"}");
  (void)emit_event(
      context, "info", "media", "media.video_send.summary",
      "{\"role\":\"device\",\"stream_id\":" +
          std::to_string(static_cast<int>(context->request.video_stream_id)) + ",\"codec\":\"" +
          json_escape(context->request.video_codec) +
          "\",\"video_packet_count\":" + std::to_string(context->video_packet_count) +
          ",\"video_bytes\":" + std::to_string(context->video_bytes) +
          ",\"first_video_packet_ms\":" + std::to_string(context->first_video_packet_ms) +
          ",\"status\":\"" + (context->video_packet_count > 0 ? "passed" : "failed") + "\"}");
  (void)tirtc_conn_service_stop(service);
  cleanup_active_sessions(context, &inputs, &active_sessions, exit_reason);
  inputs.cleanup();
  cleanup_pending_connections(&service_context);
  context->requested_video_codec = context->request.video_codec;
  context->actual_video_codec = context->request.video_codec;
  return true;
}

}  // namespace devtools_driver_probe
