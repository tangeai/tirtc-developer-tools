#include "probe_role_helpers.h"

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iomanip>
#include <limits>
#include <optional>
#include <regex>
#include <sstream>
#include <system_error>
#include <thread>
#include <utility>

namespace devtools_driver_probe {
namespace {

constexpr uint64_t kFnv1a64OffsetBasis = 14695981039346656037ULL;
constexpr uint64_t kFnv1a64Prime = 1099511628211ULL;

std::optional<std::string> get_json_string(const std::string& text, const std::string& key) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*\"((?:\\\\.|[^\"])*)\"");
  std::smatch match;
  if (!std::regex_search(text, match, pattern)) {
    return std::nullopt;
  }
  return match[1].str();
}

std::optional<int64_t> get_json_int64(const std::string& text, const std::string& key) {
  const std::regex pattern("\"" + key + "\"\\s*:\\s*(-?[0-9]+)");
  std::smatch match;
  if (!std::regex_search(text, match, pattern)) {
    return std::nullopt;
  }
  return std::stoll(match[1].str());
}

const char* conn_state_to_string(TirtcConnState state) {
  switch (state) {
    case TIRTC_CONN_STATE_IDLE:
      return "idle";
    case TIRTC_CONN_STATE_CONNECTING:
      return "connecting";
    case TIRTC_CONN_STATE_CONNECTED:
      return "connected";
    case TIRTC_CONN_STATE_DISCONNECTED:
      return "disconnected";
    default:
      return "unknown";
  }
}

}  // namespace

std::atomic<int> g_stop_requested{0};

std::string fnv1a64_hex(const void* data, size_t length) {
  uint64_t hash = kFnv1a64OffsetBasis;
  const auto* bytes = static_cast<const uint8_t*>(data);
  for (size_t index = 0; index < length; index += 1) {
    hash ^= bytes[index];
    hash *= kFnv1a64Prime;
  }
  std::ostringstream out;
  out << "fnv1a64:" << std::hex << std::setw(16) << std::setfill('0') << hash;
  return out.str();
}

void on_signal(int) {
  g_stop_requested.store(1);
}

void on_service_started(TirtcConnService*, void* user_data) {
  static_cast<ServiceContext*>(user_data)->started.store(1);
}

void on_service_stopped(TirtcConnService*, void* user_data) {
  static_cast<ServiceContext*>(user_data)->stopped.store(1);
}

void on_service_connected(TirtcConnService*, TirtcConn* connection, void* user_data) {
  auto* context = static_cast<ServiceContext*>(user_data);
  std::lock_guard<std::mutex> guard(context->connections_lock);
  context->accepted_connections.push_back(connection);
}

void on_service_error(TirtcConnService*, TirtcError, const char*, void* user_data) {
  static_cast<ServiceContext*>(user_data)->errors.store(1);
}

void on_conn_state_changed(TirtcConn*, TirtcConnState state, TirtcError error, void* user_data) {
  auto* context = static_cast<ConnCallbackContext*>(user_data);
  ConnectionEvents* events = context == nullptr ? nullptr : context->connection_events;
  if (events == nullptr) {
    return;
  }
  DriverContext* driver_context = context->driver_context;
  if (driver_context != nullptr) {
    (void)emit_event(driver_context, "info", "connection", "connection.state.changed",
                     "{\"session_index\":" + std::to_string(context->session_index) +
                         ",\"state\":\"" + conn_state_to_string(state) +
                         "\",\"state_code\":" + std::to_string(static_cast<int>(state)) +
                         ",\"error\":" + std::to_string(static_cast<int>(error)) + "}");
  }
  if (state == TIRTC_CONN_STATE_CONNECTED) {
    events->connected.store(1);
  } else if (state == TIRTC_CONN_STATE_DISCONNECTED) {
    events->disconnected.store(1);
    if (error != TIRTC_ERROR_OK) {
      events->errors.store(1);
    }
  }
}

void on_conn_command_echo(TirtcConn* connection, uint32_t command, TirtcOwnedBytes* owned_payload,
                          void* user_data) {
  auto* callback_context = static_cast<ConnCallbackContext*>(user_data);
  DriverContext* driver_context =
      callback_context == nullptr ? nullptr : callback_context->driver_context;
  const void* payload_data = owned_payload == nullptr ? nullptr : owned_payload->data;
  const size_t payload_bytes = owned_payload == nullptr ? 0 : owned_payload->length;
  const std::string payload_hash =
      fnv1a64_hex(payload_data, payload_data == nullptr ? 0 : payload_bytes);
  if (driver_context != nullptr) {
    driver_context->command_echo_received.fetch_add(1);
    {
      std::lock_guard<std::mutex> guard(driver_context->command_echo_lock);
      driver_context->command_echo_last_command = command;
      driver_context->command_echo_last_payload_bytes = payload_bytes;
      driver_context->command_echo_last_payload_hash = payload_hash;
      driver_context->command_echo_last_send_result = static_cast<int>(TIRTC_ERROR_OK);
    }
    PendingCommandEcho pending{};
    pending.connection = connection;
    pending.session_index = callback_context == nullptr ? 0 : callback_context->session_index;
    pending.command = command;
    pending.payload_hash = payload_hash;
    if (payload_data != nullptr && payload_bytes > 0) {
      const auto* bytes = static_cast<const uint8_t*>(payload_data);
      pending.payload.assign(bytes, bytes + payload_bytes);
    }
    {
      std::lock_guard<std::mutex> guard(driver_context->pending_command_echoes_lock);
      driver_context->pending_command_echoes.push_back(std::move(pending));
    }
    (void)emit_event(
        driver_context, "info", "command", "command.echo.queued",
        "{\"command_id\":" + std::to_string(command) +
            ",\"payload_bytes\":" + std::to_string(payload_bytes) + ",\"payload_hash\":\"" +
            json_escape(payload_hash) + "\",\"session_index\":" +
            std::to_string(callback_context == nullptr ? 0 : callback_context->session_index) +
            "}");
  }

  tirtc_owned_bytes_release(owned_payload);
}

void drain_pending_command_echoes(DriverContext* context) {
  if (context == nullptr) {
    return;
  }
  std::deque<PendingCommandEcho> pending;
  {
    std::lock_guard<std::mutex> guard(context->pending_command_echoes_lock);
    pending.swap(context->pending_command_echoes);
  }
  for (const PendingCommandEcho& echo_request : pending) {
    TirtcConnCommand echo{};
    echo.command = echo_request.command;
    echo.data = echo_request.payload.empty() ? nullptr : echo_request.payload.data();
    echo.length = echo_request.payload.size();
    const TirtcError send_result = echo_request.connection == nullptr
                                       ? TIRTC_ERROR_INVALID_ARGUMENT
                                       : tirtc_conn_send_command(echo_request.connection, &echo);
    if (send_result == TIRTC_ERROR_OK) {
      context->command_echo_echoed.fetch_add(1);
    } else {
      context->command_echo_errors.fetch_add(1);
    }
    {
      std::lock_guard<std::mutex> guard(context->command_echo_lock);
      context->command_echo_last_command = echo_request.command;
      context->command_echo_last_payload_bytes = echo_request.payload.size();
      context->command_echo_last_payload_hash = echo_request.payload_hash;
      context->command_echo_last_send_result = static_cast<int>(send_result);
    }
    const std::string level = send_result == TIRTC_ERROR_OK ? "info" : "error";
    const std::string kind =
        send_result == TIRTC_ERROR_OK ? "command.echo.done" : "command.echo.failed";
    (void)emit_event(context, level, "command", kind,
                     "{\"command_id\":" + std::to_string(echo_request.command) +
                         ",\"payload_bytes\":" + std::to_string(echo_request.payload.size()) +
                         ",\"payload_hash\":\"" + json_escape(echo_request.payload_hash) +
                         "\",\"send_result\":" + std::to_string(static_cast<int>(send_result)) +
                         ",\"session_index\":" + std::to_string(echo_request.session_index) + "}");
  }
}

void on_conn_stream_message(TirtcConn*, uint8_t stream_id, uint32_t timestamp_ms,
                            TirtcOwnedBytes* owned_payload, void* user_data) {
  (void)timestamp_ms;
  auto* callback_context = static_cast<ConnCallbackContext*>(user_data);
  DriverContext* driver_context =
      callback_context == nullptr ? nullptr : callback_context->driver_context;
  const void* payload_data = owned_payload == nullptr ? nullptr : owned_payload->data;
  const size_t payload_bytes = owned_payload == nullptr ? 0 : owned_payload->length;
  const std::string payload_hash =
      fnv1a64_hex(payload_data, payload_data == nullptr ? 0 : payload_bytes);
  std::string payload_text;
  if (payload_data != nullptr && payload_bytes > 0) {
    payload_text.assign(static_cast<const char*>(payload_data), payload_bytes);
  }

  bool valid_payload = !payload_text.empty();
  int64_t payload_epoch_seconds = 0;
  try {
    size_t parsed = 0;
    payload_epoch_seconds = std::stoll(payload_text, &parsed, 10);
    valid_payload = valid_payload && parsed == payload_text.size();
  } catch (...) {
    valid_payload = false;
  }

  if (driver_context != nullptr) {
    if (valid_payload && stream_id == driver_context->request.video_stream_id) {
      driver_context->stream_message_received.fetch_add(1);
      driver_context->stream_message_matched_receives.fetch_add(1);
      {
        std::lock_guard<std::mutex> guard(driver_context->stream_message_lock);
        driver_context->stream_message_last_session_index =
            callback_context == nullptr ? 0 : callback_context->session_index;
        driver_context->stream_message_last_payload_epoch_seconds = payload_epoch_seconds;
        driver_context->stream_message_has_last_payload = true;
        driver_context->stream_message_last_payload_bytes = payload_bytes;
        driver_context->stream_message_last_payload_hash = payload_hash;
      }
      (void)emit_event(
          driver_context, "info", "stream_message", "stream_message.receive.done",
          "{\"pairing_id\":\"" + json_escape(driver_context->request.pairing_id) +
              "\",\"session_index\":" +
              std::to_string(callback_context == nullptr ? 0 : callback_context->session_index) +
              ",\"stream_id\":" + std::to_string(static_cast<int>(stream_id)) +
              ",\"payload_epoch_seconds\":" + std::to_string(payload_epoch_seconds) +
              ",\"payload_bytes\":" + std::to_string(payload_bytes) + ",\"payload_hash\":\"" +
              json_escape(payload_hash) + "\",\"event_monotonic_ms\":" +
              std::to_string(elapsed_ms_since_start(driver_context)) + "}");
    } else {
      driver_context->stream_message_errors.fetch_add(1);
    }
  }

  tirtc_owned_bytes_release(owned_payload);
}

void on_audio_output_state_changed(TirtcAudioOutput*, TirtcAudioOutputState state,
                                   void* user_data) {
  auto* events = static_cast<OutputEvents*>(user_data);
  if (state == TIRTC_AUDIO_OUTPUT_STATE_PLAYING) {
    events->audio_playing.store(1);
  } else if (state == TIRTC_AUDIO_OUTPUT_STATE_FAILED) {
    events->failed.store(1);
  }
}

void on_audio_output_error(TirtcAudioOutput*, TirtcError, TirtcOwnedString* owned_message,
                           void* user_data) {
  static_cast<OutputEvents*>(user_data)->failed.store(1);
  tirtc_owned_string_release(owned_message);
}

void on_video_output_state_changed(TirtcVideoOutput*, TirtcVideoOutputState state,
                                   void* user_data) {
  auto* events = static_cast<OutputEvents*>(user_data);
  if (state == TIRTC_VIDEO_OUTPUT_STATE_RENDERING) {
    events->rendering.store(1);
  } else if (state == TIRTC_VIDEO_OUTPUT_STATE_FAILED) {
    events->failed.store(1);
  }
}

void on_video_output_error(TirtcVideoOutput*, TirtcError, TirtcOwnedString* owned_message,
                           void* user_data) {
  static_cast<OutputEvents*>(user_data)->failed.store(1);
  tirtc_owned_string_release(owned_message);
}

bool load_headless_audio_capture(AudioCaptureContext* context) {
  if (context == nullptr) {
    return false;
  }
  if (!std::filesystem::exists(context->marker_path)) {
    return false;
  }
  const std::string marker = read_text_file(context->marker_path.string());
  const auto sample_rate_hz = get_json_int64(marker, "sample_rate_hz");
  const auto channels = get_json_int64(marker, "channels");
  const auto captured_bytes = get_json_int64(marker, "captured_bytes");
  const auto first_output_ms = get_json_int64(marker, "first_output_ms");
  if (!sample_rate_hz.has_value() || !channels.has_value() || !captured_bytes.has_value() ||
      !first_output_ms.has_value() || *sample_rate_hz <= 0 || *channels <= 0 ||
      *captured_bytes <= 0 || *first_output_ms < 0) {
    return false;
  }
  std::error_code file_error;
  const uintmax_t pcm_bytes = std::filesystem::file_size(context->pcm_path, file_error);
  if (file_error || pcm_bytes == 0) {
    return false;
  }
  context->sample_rate_hz = static_cast<uint32_t>(*sample_rate_hz);
  context->channels = static_cast<uint32_t>(*channels);
  context->captured_bytes =
      std::max(static_cast<uint64_t>(*captured_bytes), static_cast<uint64_t>(pcm_bytes));
  context->first_output_ms = static_cast<int>(*first_output_ms);
  context->outputs.store(1);
  return true;
}

bool load_headless_frame_dump(FrameDumpContext* context) {
  if (context == nullptr) {
    return false;
  }

  const std::filesystem::path metadata_path = context->render_dir / "first-video-frame.json";
  if (!std::filesystem::exists(metadata_path)) {
    return false;
  }
  const std::string metadata = read_text_file(metadata_path.string());
  const auto width = get_json_int64(metadata, "width");
  const auto height = get_json_int64(metadata, "height");
  const auto pixel_format = get_json_string(metadata, "pixel_format");
  const auto pts_us = get_json_int64(metadata, "pts_us");
  const auto raw_path_value = get_json_string(metadata, "raw_path");
  const auto frame_count = get_json_int64(metadata, "frame_count");
  if (!width.has_value() || !height.has_value() || !pixel_format.has_value() ||
      !pts_us.has_value() || !raw_path_value.has_value()) {
    return false;
  }

  const std::filesystem::path raw_path(*raw_path_value);
  std::error_code file_error;
  const uintmax_t raw_bytes = std::filesystem::file_size(raw_path, file_error);
  if (file_error || raw_bytes == 0) {
    return false;
  }

  context->first_frame_width = static_cast<size_t>(*width);
  context->first_frame_height = static_cast<size_t>(*height);
  context->first_frame_pixel_format = *pixel_format;
  context->first_frame_pts_us = *pts_us;
  context->first_frame_bytes = static_cast<uint64_t>(raw_bytes);
  context->first_frame_raw_path = raw_path;
  context->first_frame_metadata_path = metadata_path;
  context->frames.store(static_cast<int>(std::max<int64_t>(frame_count.value_or(1), 1)));
  return true;
}

bool wait_until(int timeout_ms, const std::function<bool()>& predicate) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (std::chrono::steady_clock::now() < deadline && g_stop_requested.load() == 0) {
    if (predicate()) {
      return true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
  return predicate();
}

void cleanup_receive(TirtcConn* connection, TirtcAudioOutput* audio_output,
                     TirtcVideoOutput* video_output, TirtcAudioAout* aout, TirtcVideoVout* vout) {
  if (connection != nullptr) {
    (void)tirtc_conn_set_callbacks(connection, nullptr, nullptr);
  }
  if (audio_output != nullptr) {
    (void)tirtc_audio_output_set_observer(audio_output, nullptr, nullptr);
    (void)tirtc_audio_output_detach(audio_output);
  }
  if (video_output != nullptr) {
    (void)tirtc_video_output_set_observer(video_output, nullptr, nullptr);
    (void)tirtc_video_output_detach(video_output);
    (void)tirtc_video_output_detach_view(video_output);
  }
  if (connection != nullptr) {
    (void)tirtc_conn_disconnect(connection);
    tirtc_conn_destroy(connection);
  }
  if (audio_output != nullptr) {
    tirtc_audio_output_destroy(audio_output);
  }
  if (video_output != nullptr) {
    tirtc_video_output_destroy(video_output);
  }
  if (aout != nullptr) {
    tirtc_audio_aout_destroy(aout);
  }
  if (vout != nullptr) {
    tirtc_video_vout_destroy(vout);
  }
  tirtc_uninit();
}

}  // namespace devtools_driver_probe
