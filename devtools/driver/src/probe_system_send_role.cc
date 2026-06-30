#include "probe_system_send_role.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>

#include "probe_role_helpers.h"
#include "tirtc/audio_io_apple.h"
#include "tirtc/video_io.h"
#include "tirtc/video_io_apple.h"

namespace devtools_driver_probe {
namespace {

constexpr uint32_t kSystemVideoWidth = 1280;
constexpr uint32_t kSystemVideoHeight = 720;
constexpr uint32_t kSystemVideoFps = 15;
constexpr uint32_t kSystemVideoBitrateKbps = 1500;
constexpr auto kSystemPollInterval = std::chrono::milliseconds(20);
constexpr auto kStreamMessagePeriod = std::chrono::seconds(10);
constexpr auto kStreamMessageRetryDelay = std::chrono::milliseconds(250);
constexpr int kStreamMessageMinPeriodMs = 8000;
constexpr int kStreamMessageMaxPeriodMs = 12000;

TirtcError run_blocking_video_lifecycle_with_event_pump(const std::function<TirtcError()>& action) {
  std::atomic<int> done{0};
  TirtcError result = TIRTC_ERROR_OK;
  std::thread worker([&]() {
    result = action();
    done.store(1);
  });
  while (done.load() == 0) {
    pump_platform_events_once();
    std::this_thread::sleep_for(kSystemPollInterval);
  }
  worker.join();
  return result;
}

struct PreviewForwarder {
  DriverContext* context = nullptr;
  TirtcVideoVout* window_vout = nullptr;
  std::mutex lock;
  bool window_opened = false;
  std::atomic<int> frame_count{0};
  std::atomic<int> first_frame_ms{-1};
  std::atomic<int> failed{0};
  std::atomic<int> error_code{0};
};

struct SystemInputLifecycle {
  TirtcAudioInput* audio_input = nullptr;
  TirtcVideoInput* video_input = nullptr;
  TirtcAudioAin* ain = nullptr;
  TirtcVideoVin* vin = nullptr;
  TirtcVideoOutput* preview_output = nullptr;
  TirtcVideoVout* preview_vout = nullptr;
  TirtcVideoVout* preview_window_vout = nullptr;
  PreviewForwarder preview_forwarder;
  OutputEvents preview_events;
  TirtcVideoOutputObserver preview_observer{};
  TirtcAudioInputObserver audio_observer{};
  TirtcVideoInputObserver video_observer{};
  bool audio_started = false;
  bool video_started = false;
  bool preview_attached = false;

  void detach_preview() {
    if (preview_attached && video_input != nullptr) {
      (void)run_blocking_video_lifecycle_with_event_pump(
          [&]() { return tirtc_video_input_detach_preview(video_input); });
      preview_attached = false;
    }
    if (preview_output != nullptr) {
      (void)tirtc_video_output_set_observer(preview_output, nullptr, nullptr);
      (void)tirtc_video_output_detach_view(preview_output);
    }
  }

  void stop() {
    if (video_started) {
      (void)run_blocking_video_lifecycle_with_event_pump(
          [&]() { return tirtc_video_input_stop(video_input); });
      video_started = false;
    }
    if (audio_started) {
      (void)tirtc_audio_input_stop(audio_input);
      audio_started = false;
    }
  }

  void cleanup() {
    detach_preview();
    stop();
    if (preview_output != nullptr) {
      tirtc_video_output_destroy(preview_output);
      preview_output = nullptr;
    }
    if (preview_vout != nullptr) {
      tirtc_video_vout_destroy(preview_vout);
      preview_vout = nullptr;
    }
    if (preview_window_vout != nullptr) {
      tirtc_video_vout_destroy(preview_window_vout);
      preview_window_vout = nullptr;
    }
    if (video_input != nullptr) {
      tirtc_video_input_destroy(video_input);
      video_input = nullptr;
    }
    if (audio_input != nullptr) {
      tirtc_audio_input_destroy(audio_input);
      audio_input = nullptr;
    }
    if (vin != nullptr) {
      tirtc_video_vin_destroy(vin);
      vin = nullptr;
    }
    if (ain != nullptr) {
      tirtc_audio_ain_destroy(ain);
      ain = nullptr;
    }
  }
};

struct SystemConnection {
  TirtcConn* connection = nullptr;
  TirtcAudioOutput* receive_audio_output = nullptr;
  TirtcAudioAout* receive_audio_aout = nullptr;
  ConnectionEvents events;
  ConnCallbackContext callback_context;
  OutputEvents receive_audio_events;
  TirtcAudioOutputObserver receive_audio_observer{};
  int session_index = 0;
  bool audio_attached = false;
  bool video_attached = false;
  bool receive_audio_attached = false;
  bool receive_audio_raw_dump_active = false;
  bool sent_first_stream_message = false;
  std::chrono::steady_clock::time_point receive_audio_started_at{};
  std::chrono::steady_clock::time_point next_stream_message_send_at{};
};

bool system_output_requested(const DriverContext* context) {
  return context != nullptr &&
         (context->request.output_mode == "system" || context->request.output_mode == "both");
}

bool file_output_requested(const DriverContext* context) {
  return context != nullptr &&
         (context->request.output_mode == "file" || context->request.output_mode == "both");
}

std::string audio_codec_label_for_runtime_codec(TirtcMediaCodec codec) {
  switch (codec) {
    case TIRTC_MEDIA_CODEC_AUDIO_AAC:
      return "aac";
    case TIRTC_MEDIA_CODEC_AUDIO_G711A:
      return "g711a";
    case TIRTC_MEDIA_CODEC_AUDIO_OPUS:
      return "opus";
    case TIRTC_MEDIA_CODEC_AUDIO_AMR:
      return "amr";
    default:
      return "pcm";
  }
}

void on_receive_audio_frame(TirtcAudioAout*, const TirtcAudioPcmFrame*, void*) {}

void start_stage_if_not_started(DriverContext* context, const std::string& stage) {
  if (context == nullptr) {
    return;
  }
  StageStatus& status = context->stages[stage];
  if (status.status == StageResult::NotStarted) {
    start_stage(context, stage);
  }
}

void finish_stage_if_running(DriverContext* context, const std::string& stage, StageResult result,
                             const std::string& reason_code, const std::string& evidence_event_id) {
  if (context == nullptr) {
    return;
  }
  StageStatus& status = context->stages[stage];
  if (status.status == StageResult::Running || status.status == StageResult::NotStarted) {
    if (status.status == StageResult::NotStarted) {
      start_stage(context, stage);
    }
    finish_stage(context, stage, result, reason_code, evidence_event_id);
  }
}

void cleanup_system_receive_audio(SystemConnection* session) {
  if (session == nullptr) {
    return;
  }
  if (session->receive_audio_raw_dump_active && session->receive_audio_output != nullptr) {
    (void)tirtc_audio_output_stop_raw_dump(session->receive_audio_output);
    session->receive_audio_raw_dump_active = false;
  }
  if (session->receive_audio_output != nullptr) {
    (void)tirtc_audio_output_set_observer(session->receive_audio_output, nullptr, nullptr);
    (void)tirtc_audio_output_detach(session->receive_audio_output);
    session->receive_audio_attached = false;
  }
  if (session->receive_audio_output != nullptr) {
    tirtc_audio_output_destroy(session->receive_audio_output);
    session->receive_audio_output = nullptr;
  }
  if (session->receive_audio_aout != nullptr) {
    tirtc_audio_aout_destroy(session->receive_audio_aout);
    session->receive_audio_aout = nullptr;
  }
}

void on_preview_forward_frame(TirtcVideoVout*, const TirtcVideoPixelFrame* frame, void* user_data) {
  auto* forwarder = static_cast<PreviewForwarder*>(user_data);
  if (forwarder == nullptr || frame == nullptr || forwarder->window_vout == nullptr) {
    return;
  }
  const int previous_count = forwarder->frame_count.fetch_add(1);
  if (previous_count == 0 && forwarder->context != nullptr) {
    const int first_frame_ms = elapsed_ms_since_start(forwarder->context);
    forwarder->first_frame_ms.store(first_frame_ms);
    forwarder->context->first_video_packet_ms = first_frame_ms;
    forwarder->context->first_key_frame_ms = first_frame_ms;
    forwarder->context->first_decoded_frame_ms = first_frame_ms;
    forwarder->context->first_rendered_frame_ms = first_frame_ms;
    forwarder->context->video_packet_count = 1;
    forwarder->context->decoded_video_frame_count = 1;
    (void)emit_event(forwarder->context, "info", "media", "media.system_video.first_frame",
                     "{\"width\":" + std::to_string(frame->width) +
                         ",\"height\":" + std::to_string(frame->height) +
                         ",\"first_frame_ms\":" + std::to_string(first_frame_ms) + "}");
  }

  TirtcError render_error = TIRTC_ERROR_OK;
  {
    std::lock_guard<std::mutex> guard(forwarder->lock);
    if (!forwarder->window_opened) {
      TirtcVideoIoConfig config{};
      config.width = frame->width;
      config.height = frame->height;
      config.fps = kSystemVideoFps;
      config.pixel_format = frame->pixel_format;
      render_error = tirtc_video_vout_open(forwarder->window_vout, &config);
      if (render_error == TIRTC_ERROR_OK) {
        forwarder->window_opened = true;
      }
    }
    if (render_error == TIRTC_ERROR_OK) {
      render_error = tirtc_video_vout_render_frame(forwarder->window_vout, frame);
    }
  }
  if (render_error != TIRTC_ERROR_OK) {
    forwarder->failed.store(1);
    forwarder->error_code.store(static_cast<int>(render_error));
  }
}

void on_preview_forward_error(TirtcVideoVout*, TirtcError error, void* user_data) {
  auto* forwarder = static_cast<PreviewForwarder*>(user_data);
  if (forwarder == nullptr) {
    return;
  }
  forwarder->failed.store(1);
  forwarder->error_code.store(static_cast<int>(error));
}

int64_t current_epoch_seconds() {
  const auto now = std::chrono::system_clock::now();
  return static_cast<int64_t>(std::chrono::system_clock::to_time_t(now));
}

bool is_transient_transport_send_error(TirtcError status) {
  return status == TIRTC_ERROR_TRANSPORT_INVALID_HANDLE || status == TIRTC_ERROR_TRANSPORT_BUSY ||
         status == TIRTC_ERROR_NOT_CONNECTED || status == TIRTC_ERROR_TRANSPORT_TIMEOUT ||
         status == TIRTC_ERROR_TRANSPORT_BACKEND_CONNECTION_OTHER_ERROR;
}

void send_stream_message_for_session(DriverContext* context, SystemConnection* session) {
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

bool take_next_system_connection(ServiceContext* service_context, TirtcConn** out_connection) {
  std::lock_guard<std::mutex> guard(service_context->connections_lock);
  if (service_context->accepted_connections.empty()) {
    *out_connection = nullptr;
    return false;
  }
  *out_connection = service_context->accepted_connections.front();
  service_context->accepted_connections.pop_front();
  return true;
}

bool create_preview_output(DriverContext* context, SystemInputLifecycle* inputs) {
  if (!context->request.preview_requested) {
    context->preview_state = "not_requested";
    return true;
  }
#if defined(__APPLE__)
  if (tirtc_video_output_create(&inputs->preview_output) != TIRTC_ERROR_OK ||
      inputs->preview_output == nullptr ||
      tirtc_video_apple_create_core_video_vout(&inputs->preview_window_vout) != TIRTC_ERROR_OK ||
      inputs->preview_window_vout == nullptr) {
    context->preview_state = "failed";
    return false;
  }
  TirtcVideoAppleCoreVideoVoutOptions options{};
  options.target = TIRTC_VIDEO_APPLE_VOUT_TARGET_APPKIT_WINDOW;
  options.window_title = "TiRTC DevTools Local Preview";
  options.window_slot = TIRTC_VIDEO_APPLE_WINDOW_SLOT_LEFT;
  if (tirtc_video_apple_core_video_vout_set_options(inputs->preview_window_vout, &options) !=
      TIRTC_ERROR_OK) {
    context->preview_state = "failed";
    return false;
  }
  inputs->preview_forwarder.context = context;
  inputs->preview_forwarder.window_vout = inputs->preview_window_vout;
  TirtcVideoCallbackVoutOptions callback_options{};
  callback_options.on_frame = on_preview_forward_frame;
  callback_options.on_error = on_preview_forward_error;
  callback_options.user_data = &inputs->preview_forwarder;
  if (tirtc_video_vout_create_callback(&callback_options, &inputs->preview_vout) !=
          TIRTC_ERROR_OK ||
      inputs->preview_vout == nullptr) {
    context->preview_state = "failed";
    return false;
  }
  inputs->preview_observer.on_state_changed = on_video_output_state_changed;
  inputs->preview_observer.on_error = on_video_output_error;
  if (tirtc_video_output_set_observer(inputs->preview_output, &inputs->preview_observer,
                                      &inputs->preview_events) != TIRTC_ERROR_OK ||
      tirtc_video_output_attach_view(inputs->preview_output, inputs->preview_vout) !=
          TIRTC_ERROR_OK) {
    context->preview_state = "failed";
    return false;
  }
  context->preview_state = "window_created";
  (void)emit_event(context, "info", "output", "preview.window_created",
                   "{\"window_title\":\"TiRTC DevTools Local Preview\"}");
  return true;
#else
  context->preview_state = "failed";
  return false;
#endif
}

void on_system_audio_input_state(TirtcAudioInput*, TirtcInputState state, void* user_data) {
  auto* context = static_cast<DriverContext*>(user_data);
  if (context == nullptr) {
    return;
  }
  if (state == TIRTC_INPUT_STATE_RUNNING && context->first_audio_packet_ms < 0) {
    context->first_audio_packet_ms = elapsed_ms_since_start(context);
    context->audio_packet_count = 1;
    (void)emit_event(
        context, "info", "media", "media.system_audio.first_packet",
        "{\"audio_codec\":\"" + json_escape(context->request.audio_codec) +
            "\",\"sample_rate_hz\":" + std::to_string(context->request.audio_sample_rate_hz) +
            ",\"channels\":" + std::to_string(context->request.audio_channels) +
            ",\"first_packet_ms\":" + std::to_string(context->first_audio_packet_ms) + "}");
  }
}

void on_system_audio_input_error(TirtcAudioInput*, TirtcError, TirtcOwnedString* owned_message,
                                 void*) {
  tirtc_owned_string_release(owned_message);
}

void on_system_video_input_state(TirtcVideoInput*, TirtcInputState, void*) {}

void on_system_video_output_size(TirtcVideoInput*, uint32_t width, uint32_t height,
                                 void* user_data) {
  (void)width;
  (void)height;
  (void)user_data;
}

void on_system_video_input_error(TirtcVideoInput*, TirtcError, TirtcOwnedString* owned_message,
                                 void*) {
  tirtc_owned_string_release(owned_message);
}

bool start_system_inputs(DriverContext* context, SystemInputLifecycle* inputs,
                         std::string* reason_code) {
#if defined(__APPLE__)
  if (tirtc_audio_input_create(&inputs->audio_input) != TIRTC_ERROR_OK ||
      inputs->audio_input == nullptr ||
      tirtc_video_input_create(&inputs->video_input) != TIRTC_ERROR_OK ||
      inputs->video_input == nullptr ||
      tirtc_audio_apple_create_audio_toolbox_ain(&inputs->ain) != TIRTC_ERROR_OK ||
      inputs->ain == nullptr ||
      tirtc_video_apple_create_avfoundation_vin(&inputs->vin) != TIRTC_ERROR_OK ||
      inputs->vin == nullptr) {
    *reason_code = "system_io_failed";
    return false;
  }

  TirtcAudioInputOptions audio_options{};
  audio_options.codec = audio_codec_to_runtime_codec(context->request.audio_codec);
  audio_options.sample_rate_hz = context->request.audio_sample_rate_hz;
  audio_options.channels = context->request.audio_channels;
  audio_options.aec_mode = static_cast<TirtcAudioAecMode>(context->request.audio_input_aec_mode);
  audio_options.agc_level = static_cast<TirtcAudioAgcLevel>(context->request.audio_input_agc_level);
  audio_options.ans_level = static_cast<TirtcAudioAnsLevel>(context->request.audio_input_ans_level);

  TirtcVideoInputOptions video_options{};
  video_options.codec = codec_to_runtime_codec(context->request.video_codec);
  video_options.width = kSystemVideoWidth;
  video_options.height = kSystemVideoHeight;
  video_options.fps = kSystemVideoFps;
  video_options.bitrate_kbps = kSystemVideoBitrateKbps;
  video_options.encoder_preference = TIRTC_VIDEO_ENCODER_PREFERENCE_AUTO;

  if (tirtc_audio_input_set_ain(inputs->audio_input, inputs->ain) != TIRTC_ERROR_OK ||
      (inputs->audio_observer.on_state_changed = on_system_audio_input_state, false) ||
      (inputs->audio_observer.on_error = on_system_audio_input_error, false) ||
      tirtc_audio_input_set_observer(inputs->audio_input, &inputs->audio_observer, context) !=
          TIRTC_ERROR_OK ||
      tirtc_audio_input_set_options(inputs->audio_input, &audio_options) != TIRTC_ERROR_OK ||
      tirtc_video_input_set_vin(inputs->video_input, inputs->vin) != TIRTC_ERROR_OK ||
      (inputs->video_observer.on_state_changed = on_system_video_input_state, false) ||
      (inputs->video_observer.on_output_size_changed = on_system_video_output_size, false) ||
      (inputs->video_observer.on_error = on_system_video_input_error, false) ||
      tirtc_video_input_set_observer(inputs->video_input, &inputs->video_observer, context) !=
          TIRTC_ERROR_OK ||
      tirtc_video_input_set_options(inputs->video_input, &video_options) != TIRTC_ERROR_OK ||
      !create_preview_output(context, inputs)) {
    *reason_code = "system_io_failed";
    return false;
  }
  if (context->request.preview_requested &&
      tirtc_video_input_attach_preview(inputs->video_input, inputs->preview_output) !=
          TIRTC_ERROR_OK) {
    context->preview_state = "failed";
    *reason_code = "system_io_failed";
    return false;
  }
  inputs->preview_attached = context->request.preview_requested;

  if (tirtc_audio_input_start(inputs->audio_input) != TIRTC_ERROR_OK ||
      tirtc_video_input_start(inputs->video_input) != TIRTC_ERROR_OK) {
    *reason_code = "system_io_failed";
    return false;
  }
  inputs->audio_started = true;
  inputs->video_started = true;
  if (context->first_audio_packet_ms < 0) {
    context->first_audio_packet_ms = elapsed_ms_since_start(context);
  }
  context->audio_packet_count = 1;
  context->audio_bytes = 0;
  return true;
#else
  (void)context;
  (void)inputs;
  *reason_code = "unsupported_platform_capability";
  return false;
#endif
}

bool wait_for_preview(DriverContext* context, SystemInputLifecycle* inputs, int timeout_ms) {
  if (!context->request.preview_requested) {
    return true;
  }
  context->preview_state = "window_created";
  const bool rendered = wait_until(timeout_ms, [&]() {
    return inputs->preview_forwarder.frame_count.load() > 0 ||
           inputs->preview_events.rendering.load() != 0 ||
           inputs->preview_forwarder.failed.load() != 0 ||
           inputs->preview_events.failed.load() != 0;
  });
  if (rendered && inputs->preview_forwarder.frame_count.load() > 0) {
    context->preview_first_frame_ms = inputs->preview_forwarder.first_frame_ms.load();
    context->preview_frame_count = inputs->preview_forwarder.frame_count.load();
    context->preview_state = "first_frame";
    return true;
  }
  if (inputs->preview_forwarder.error_code.load() != 0) {
    context->preview_error_code = inputs->preview_forwarder.error_code.load();
  }
  context->preview_state = "failed";
  return false;
}

bool start_system_receive_audio(DriverContext* context, SystemConnection* session,
                                std::string* reason_code, std::string* event_kind) {
  if (context == nullptr || session == nullptr || !context->request.receive_audio_enabled) {
    return true;
  }
  if (session->connection == nullptr) {
    *reason_code = "output_sink_unavailable";
    *event_kind = "output.audio_receive.failed";
    return false;
  }

  context->received_audio_enabled = true;
  session->receive_audio_observer.on_state_changed = on_audio_output_state_changed;
  session->receive_audio_observer.on_error = on_audio_output_error;
  if (tirtc_audio_output_create(&session->receive_audio_output) != TIRTC_ERROR_OK ||
      session->receive_audio_output == nullptr ||
      tirtc_audio_output_set_observer(session->receive_audio_output,
                                      &session->receive_audio_observer,
                                      &session->receive_audio_events) != TIRTC_ERROR_OK) {
    *reason_code = "output_sink_unavailable";
    *event_kind = "output.audio_receive.failed";
    cleanup_system_receive_audio(session);
    return false;
  }

  if (system_output_requested(context)) {
#if defined(__APPLE__)
    if (tirtc_audio_apple_create_audio_queue_aout(&session->receive_audio_aout) != TIRTC_ERROR_OK ||
        session->receive_audio_aout == nullptr) {
      *reason_code = "output_sink_unavailable";
      *event_kind = "system_output.audio.failed";
      cleanup_system_receive_audio(session);
      return false;
    }
#else
    *reason_code = "unsupported_platform_capability";
    *event_kind = "system_output.audio.failed";
    cleanup_system_receive_audio(session);
    return false;
#endif
  } else {
    TirtcAudioCallbackAoutOptions callback_options{};
    callback_options.on_frame = on_receive_audio_frame;
    if (tirtc_audio_aout_create_callback(&callback_options, &session->receive_audio_aout) !=
            TIRTC_ERROR_OK ||
        session->receive_audio_aout == nullptr) {
      *reason_code = "output_sink_unavailable";
      *event_kind = "output.audio_receive.failed";
      cleanup_system_receive_audio(session);
      return false;
    }
  }

  if (tirtc_audio_output_set_aout(session->receive_audio_output, session->receive_audio_aout) !=
          TIRTC_ERROR_OK ||
      tirtc_audio_output_attach(session->receive_audio_output, session->connection,
                                static_cast<uint8_t>(context->request.receive_audio_stream_id)) !=
          TIRTC_ERROR_OK) {
    *reason_code = "output_sink_unavailable";
    *event_kind = "output.audio_receive.failed";
    cleanup_system_receive_audio(session);
    return false;
  }
  session->receive_audio_attached = true;
  session->receive_audio_started_at = std::chrono::steady_clock::now();

  if (file_output_requested(context)) {
    const TirtcError dump_status = tirtc_audio_output_start_raw_dump(session->receive_audio_output);
    if (dump_status != TIRTC_ERROR_OK) {
      *reason_code = "file_output_failed";
      *event_kind = "output.file_dump.start.failed";
      cleanup_system_receive_audio(session);
      return false;
    }
    session->receive_audio_raw_dump_active = true;
  }

  start_stage_if_not_started(context, "media_receive");
  start_stage_if_not_started(context, "output");
  (void)emit_event(
      context, "info", "output", "output.audio_receive.start",
      "{\"session_index\":" + std::to_string(session->session_index) +
          ",\"stream_id\":" + std::to_string(context->request.receive_audio_stream_id) +
          ",\"output_mode\":\"" + json_escape(context->request.output_mode) +
          "\",\"system_output\":" + (system_output_requested(context) ? "true" : "false") +
          ",\"file_output\":" + (file_output_requested(context) ? "true" : "false") + "}");
  return true;
}

void record_system_receive_audio_if_ready(DriverContext* context, SystemConnection* session) {
  if (context == nullptr || session == nullptr || !context->request.receive_audio_enabled ||
      context->received_audio_observed || !session->receive_audio_attached ||
      session->receive_audio_output == nullptr) {
    return;
  }

  TirtcAudioOutputDebugSnapshot snapshot{};
  if (tirtc_audio_output_get_debug_snapshot(session->receive_audio_output, &snapshot) !=
          TIRTC_ERROR_OK ||
      snapshot.codec == TIRTC_MEDIA_CODEC_NONE || snapshot.sample_rate_hz == 0 ||
      snapshot.channels == 0) {
    return;
  }
  if (system_output_requested(context) && session->receive_audio_events.audio_playing.load() == 0) {
    return;
  }

  const int first_output_ms = elapsed_ms_since_start(context);
  context->received_audio_enabled = true;
  context->received_audio_observed = true;
  context->received_audio_codec = audio_codec_label_for_runtime_codec(snapshot.codec);
  context->received_audio_sample_rate_hz = snapshot.sample_rate_hz;
  context->received_audio_channels = snapshot.channels;
  context->received_audio_first_output_timing_ms = first_output_ms;
  if (system_output_requested(context)) {
    context->first_audio_output_ms = first_output_ms;
  }
  context->system_audio_error_code = session->receive_audio_events.audio_error_code.load();
  const std::string event_id = emit_event(
      context, "info", "output",
      system_output_requested(context) ? "system_output.audio.playing"
                                       : "output.audio_receive.first_output",
      "{\"session_index\":" + std::to_string(session->session_index) +
          ",\"stream_id\":" + std::to_string(context->request.receive_audio_stream_id) +
          ",\"codec\":\"" + json_escape(context->received_audio_codec) +
          "\",\"sample_rate_hz\":" + std::to_string(context->received_audio_sample_rate_hz) +
          ",\"channels\":" + std::to_string(context->received_audio_channels) +
          ",\"first_output_ms\":" + std::to_string(first_output_ms) + "}");
  finish_stage_if_running(context, "media_receive", StageResult::Passed, "ok", event_id);
  finish_stage_if_running(context, "output", StageResult::Passed, "ok", event_id);
}

bool attach_system_connection(DriverContext* context, SystemInputLifecycle* inputs,
                              SystemConnection* session) {
  session->callback_context.driver_context = context;
  session->callback_context.connection_events = &session->events;
  session->callback_context.session_index = session->session_index;
  TirtcConnCallbacks conn_callbacks{};
  conn_callbacks.on_state_changed = on_conn_state_changed;
  conn_callbacks.on_command = on_conn_command_echo;
  conn_callbacks.on_stream_message = on_conn_stream_message;
  if (tirtc_conn_set_callbacks(session->connection, &conn_callbacks, &session->callback_context) !=
          TIRTC_ERROR_OK ||
      tirtc_audio_input_attach(inputs->audio_input, session->connection,
                               context->request.audio_stream_id) != TIRTC_ERROR_OK ||
      tirtc_video_input_attach(inputs->video_input, session->connection,
                               context->request.video_stream_id) != TIRTC_ERROR_OK) {
    return false;
  }
  session->audio_attached = true;
  session->video_attached = true;
  std::string reason_code;
  std::string event_kind;
  if (!start_system_receive_audio(context, session, &reason_code, &event_kind)) {
    context->reason_code = reason_code;
    (void)emit_event(context, "error", "output", event_kind,
                     "{\"reason_code\":\"" + json_escape(reason_code) + "\"}");
    return false;
  }
  (void)emit_event(context, "info", "media", "media.system_input.attach",
                   "{\"session_index\":" + std::to_string(session->session_index) +
                       ",\"audio_stream_id\":" +
                       std::to_string(static_cast<int>(context->request.audio_stream_id)) +
                       ",\"video_stream_id\":" +
                       std::to_string(static_cast<int>(context->request.video_stream_id)) +
                       ",\"audio_codec\":\"" + json_escape(context->request.audio_codec) +
                       "\",\"video_codec\":\"" + json_escape(context->request.video_codec) + "\"}");
  return true;
}

void cleanup_system_connections(SystemInputLifecycle* inputs,
                                std::vector<std::unique_ptr<SystemConnection>>* sessions) {
  for (const auto& session : *sessions) {
    cleanup_system_receive_audio(session.get());
    if (session->video_attached) {
      (void)tirtc_video_input_detach(inputs->video_input, session->connection);
      session->video_attached = false;
    }
    if (session->audio_attached) {
      (void)tirtc_audio_input_detach(inputs->audio_input, session->connection);
      session->audio_attached = false;
    }
    if (session->connection != nullptr) {
      (void)tirtc_conn_set_callbacks(session->connection, nullptr, nullptr);
    }
  }
  sessions->clear();
}

bool any_system_session_disconnected(
    const std::vector<std::unique_ptr<SystemConnection>>& sessions) {
  return std::any_of(sessions.begin(), sessions.end(), [](const auto& session) {
    return session != nullptr && session->events.disconnected.load() != 0;
  });
}

void record_system_receive_audio_for_sessions(
    DriverContext* context, const std::vector<std::unique_ptr<SystemConnection>>& sessions) {
  if (context == nullptr || context->received_audio_observed) {
    return;
  }
  for (const auto& session : sessions) {
    record_system_receive_audio_if_ready(context, session.get());
    if (context->received_audio_observed) {
      return;
    }
  }
}

bool receive_audio_timeout_expired(const DriverContext* context,
                                   const std::vector<std::unique_ptr<SystemConnection>>& sessions) {
  if (context == nullptr || !context->request.receive_audio_enabled ||
      context->received_audio_observed ||
      !device_receive_audio_observation_required(context->request)) {
    return false;
  }
  const auto now = std::chrono::steady_clock::now();
  const auto timeout = std::chrono::milliseconds(context->request.first_output_timeout_ms);
  return std::any_of(sessions.begin(), sessions.end(), [&](const auto& session) {
    return session != nullptr && session->receive_audio_attached &&
           session->receive_audio_started_at != std::chrono::steady_clock::time_point{} &&
           now - session->receive_audio_started_at >= timeout;
  });
}

void stop_system_receive_audio_raw_dumps(
    const std::vector<std::unique_ptr<SystemConnection>>& sessions) {
  for (const auto& session : sessions) {
    if (session != nullptr && session->receive_audio_raw_dump_active &&
        session->receive_audio_output != nullptr) {
      (void)tirtc_audio_output_stop_raw_dump(session->receive_audio_output);
      session->receive_audio_raw_dump_active = false;
    }
  }
}

}  // namespace

bool run_system_send_role(DriverContext* context, TirtcConnService* service,
                          ServiceContext* service_context) {
  SystemInputLifecycle inputs{};
  std::vector<std::unique_ptr<SystemConnection>> sessions;
  bool media_stage_started = false;
  bool media_stage_finished = false;
  bool accepted_any_session = false;
  bool receive_audio_wait_expired = false;
  int session_index = 0;
  const auto started = std::chrono::steady_clock::now();
  const bool has_deadline = context->request.duration_ms > 0;
  const auto deadline = started + std::chrono::milliseconds(context->request.duration_ms);

  auto fail = [&](const std::string& reason_code, const std::string& stage,
                  const std::string& event_kind) -> bool {
    context->reason_code = reason_code;
    const std::string event_id =
        emit_event(context, "error", stage == "output" ? "output" : "media", event_kind,
                   "{\"reason_code\":\"" + json_escape(reason_code) + "\"}");
    finish_stage(context, stage, StageResult::Failed, reason_code, event_id);
    const bool preview_attached_before_cleanup = inputs.preview_attached;
    cleanup_system_connections(&inputs, &sessions);
    inputs.cleanup();
    (void)emit_event(context, "info", "media", "media.system_input.cleanup.done",
                     "{\"preview_attached_before_cleanup\":" +
                         std::string(preview_attached_before_cleanup ? "true" : "false") +
                         ",\"runtime_uninit\":true}");
    (void)tirtc_conn_service_stop(service);
    (void)upload_logs_on_failure(context);
    tirtc_uninit();
    return false;
  };

  std::string reason_code;
  start_stage(context, "media_send");
  media_stage_started = true;
  if (!start_system_inputs(context, &inputs, &reason_code)) {
    return fail(reason_code, "media_send", "media.system_input.failed");
  }
  const std::string input_started_event = emit_event(
      context, "info", "media", "media.system_input.start",
      "{\"audio_codec\":\"" + json_escape(context->request.audio_codec) + "\",\"video_codec\":\"" +
          json_escape(context->request.video_codec) +
          "\",\"sample_rate_hz\":" + std::to_string(context->request.audio_sample_rate_hz) +
          ",\"channels\":" + std::to_string(context->request.audio_channels) + "}");

  if (context->request.preview_requested) {
    start_stage(context, "output");
    int preview_timeout_ms = context->request.first_output_timeout_ms;
    if (has_deadline) {
      const auto remaining_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                                    deadline - std::chrono::steady_clock::now())
                                    .count();
      preview_timeout_ms =
          std::max(0, std::min(preview_timeout_ms, static_cast<int>(remaining_ms)));
    }
    if (!wait_for_preview(context, &inputs, preview_timeout_ms)) {
      return fail("first_output_timeout", "output", "preview.failed");
    }
    const std::string preview_event =
        emit_event(context, "info", "output", "preview.first_frame",
                   "{\"first_frame_ms\":" + std::to_string(context->preview_first_frame_ms) +
                       ",\"frame_count\":" + std::to_string(context->preview_frame_count) + "}");
    finish_stage(context, "output", StageResult::Passed, "ok", preview_event);
  }

  finish_stage(context, "media_send", StageResult::Passed, "ok", input_started_event);
  media_stage_finished = true;
  context->ready_at = now_rfc3339();

  while (g_stop_requested.load() == 0 && service_context->errors.load() == 0 &&
         service_context->stopped.load() == 0 &&
         (!has_deadline || std::chrono::steady_clock::now() < deadline)) {
    for (;;) {
      TirtcConn* connection = nullptr;
      if (!take_next_system_connection(service_context, &connection)) {
        break;
      }
      if (connection == nullptr) {
        continue;
      }
      auto session = std::make_unique<SystemConnection>();
      session_index += 1;
      session->connection = connection;
      session->session_index = session_index;
      if (!attach_system_connection(context, &inputs, session.get())) {
        return fail("media_send_failed", "media_send", "media.system_input.attach.failed");
      }
      accepted_any_session = true;
      sessions.push_back(std::move(session));
    }

    drain_pending_command_echoes(context);
    record_system_receive_audio_for_sessions(context, sessions);
    if (receive_audio_timeout_expired(context, sessions)) {
      receive_audio_wait_expired = true;
      break;
    }
    const auto stream_message_now = std::chrono::steady_clock::now();
    for (const auto& session : sessions) {
      if (!session->sent_first_stream_message) {
        if (session->next_stream_message_send_at == std::chrono::steady_clock::time_point{} ||
            stream_message_now >= session->next_stream_message_send_at) {
          send_stream_message_for_session(context, session.get());
        }
      } else if (session->next_stream_message_send_at != std::chrono::steady_clock::time_point{} &&
                 stream_message_now >= session->next_stream_message_send_at) {
        send_stream_message_for_session(context, session.get());
      }
    }
    pump_platform_events_once();
    if (context->request.exit_after_first_session && accepted_any_session &&
        any_system_session_disconnected(sessions)) {
      break;
    }
    std::this_thread::sleep_for(kSystemPollInterval);
  }
  record_system_receive_audio_for_sessions(context, sessions);
  stop_system_receive_audio_raw_dumps(sessions);

  bool role_ok = true;
  if (context->request.receive_audio_enabled && accepted_any_session &&
      !context->received_audio_observed) {
    if (device_receive_audio_observation_required(context->request)) {
      role_ok = false;
      context->reason_code =
          receive_audio_wait_expired ? "first_output_timeout" : "audio_receive_not_observed";
      const std::string event_id = emit_event(
          context, "error", "output",
          receive_audio_wait_expired ? "system_output.audio.timeout"
                                     : "output.audio_receive.not_observed",
          "{\"reason_code\":\"" + context->reason_code +
              "\",\"stream_id\":" + std::to_string(context->request.receive_audio_stream_id) +
              ",\"system_output\":" + (system_output_requested(context) ? "true" : "false") +
              ",\"file_output\":" + (file_output_requested(context) ? "true" : "false") + "}");
      finish_stage_if_running(context, "media_receive", StageResult::Failed, context->reason_code,
                              event_id);
      finish_stage(context, "output", StageResult::Failed, context->reason_code, event_id);
    } else {
      const std::string event_id = emit_event(
          context, "info", "output", "output.audio_receive.pending",
          "{\"reason_code\":\"audio_receive_pending\",\"stream_id\":" +
              std::to_string(context->request.receive_audio_stream_id) +
              ",\"system_output\":" + (system_output_requested(context) ? "true" : "false") +
              ",\"file_output\":" + (file_output_requested(context) ? "true" : "false") +
              ",\"observation_required\":false}");
      finish_stage_if_running(context, "media_receive", StageResult::Skipped,
                              "audio_receive_pending", event_id);
      finish_stage_if_running(context, "output", StageResult::Skipped, "audio_receive_pending",
                              event_id);
    }
  }
  if (role_ok && context->request.receive_audio_enabled && accepted_any_session &&
      context->received_audio_observed && file_output_requested(context) &&
      !write_media_receive_artifacts(context)) {
    role_ok = false;
    const std::string event_id = emit_event(context, "error", "output", "output.file_dump.failed",
                                            "{\"reason_code\":\"file_output_failed\"}");
    finish_stage(context, "output", StageResult::Failed, "file_output_failed", event_id);
  }
  if (!role_ok) {
    (void)upload_logs_on_failure(context);
  }

  if (!media_stage_finished && media_stage_started) {
    finish_stage(context, "media_send", StageResult::Passed, "ok", "");
  }
  (void)tirtc_conn_service_stop(service);
  const bool preview_attached_before_cleanup = inputs.preview_attached;
  cleanup_system_connections(&inputs, &sessions);
  inputs.cleanup();
  (void)emit_event(context, "info", "media", "media.system_input.cleanup.done",
                   "{\"preview_attached_before_cleanup\":" +
                       std::string(preview_attached_before_cleanup ? "true" : "false") +
                       ",\"runtime_uninit\":true}");
  if (context->stop_reason.empty()) {
    if (g_stop_requested.load() != 0) {
      context->stop_reason = "signal";
    } else if (has_deadline && std::chrono::steady_clock::now() >= deadline) {
      context->stop_reason = "duration_elapsed";
    }
  }
  tirtc_uninit();
  return role_ok;
}

}  // namespace devtools_driver_probe
