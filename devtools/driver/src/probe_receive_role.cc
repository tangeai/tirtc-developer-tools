#include "probe_role_helpers.h"
#include "tirtc/video_io.h"

namespace devtools_driver_probe {
namespace {

constexpr int kReceivePacketEvidenceReadLimit = 300;
constexpr uint32_t kAudioCaptureMaxBytes = 64 * 1024;
constexpr uint64_t kEstimatedPcmBytesPerPacket = 320;

std::string codec_label_for_runtime_codec(TirtcMediaCodec codec) {
  switch (codec) {
    case TIRTC_MEDIA_CODEC_VIDEO_H265:
      return "h265";
    case TIRTC_MEDIA_CODEC_VIDEO_MJPEG:
      return "mjpeg";
    case TIRTC_MEDIA_CODEC_VIDEO_H264:
      return "h264";
    default:
      return "";
  }
}

PacketEntry select_receive_packet_evidence(const std::filesystem::path& packets_path,
                                           bool require_key_frame) {
  const std::vector<PacketEntry> packets =
      read_packets(packets_path, kReceivePacketEvidenceReadLimit);
  if (packets.empty()) {
    return PacketEntry{};
  }
  if (!require_key_frame) {
    return packets.front();
  }
  for (const PacketEntry& packet : packets) {
    if (packet.is_key_frame) {
      return packet;
    }
  }
  return packets.front();
}

}  // namespace

bool run_receive_role(DriverContext* context) {
  start_stage(context, "endpoint");
  const std::string log_root_dir = (context->artifact_root / "runtime-log").string();
  TirtcInitOptions init_options{};
  init_options.app_id = context->request.app_id.empty() ? std::getenv("TIRTC_APP_ID")
                                                        : context->request.app_id.c_str();
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

  TirtcConn* connection = nullptr;
  TirtcAudioOutput* audio_output = nullptr;
  TirtcVideoOutput* video_output = nullptr;
  TirtcAudioAout* aout = nullptr;
  TirtcVideoVout* vout = nullptr;
  ConnectionEvents connection_events{};
  ConnCallbackContext conn_callback_context{};
  conn_callback_context.driver_context = context;
  conn_callback_context.connection_events = &connection_events;
  conn_callback_context.session_index = 1;
  OutputEvents output_events{};
  AudioCaptureContext audio_context{};
  const std::filesystem::path audio_dir = context->artifact_root / "audio";
  audio_context.marker_path = audio_dir / "first-output.json";
  audio_context.pcm_path = audio_dir / "output.pcm";
  FrameDumpContext frame_context{};
  frame_context.render_dir = context->artifact_root / "render";
  frame_context.stream_id = context->request.video_stream_id;
  const std::string audio_marker_path = audio_context.marker_path.string();
  const std::string audio_pcm_path = audio_context.pcm_path.string();
  const std::string first_frame_json_path =
      (frame_context.render_dir / "first-video-frame.json").string();
  const std::string first_frame_raw_path =
      (frame_context.render_dir / "first-video-frame.raw").string();

  TirtcAudioHeadlessAoutOptions aout_options{};
  aout_options.first_output_json_path = audio_marker_path.c_str();
  aout_options.pcm_path = audio_pcm_path.c_str();
  aout_options.max_capture_bytes = kAudioCaptureMaxBytes;
  TirtcVideoHeadlessVoutOptions vout_options{};
  vout_options.first_frame_json_path = first_frame_json_path.c_str();
  vout_options.first_frame_raw_path = first_frame_raw_path.c_str();

  TirtcConnCallbacks conn_callbacks{};
  conn_callbacks.on_state_changed = on_conn_state_changed;
  conn_callbacks.on_command = on_conn_command_echo;
  conn_callbacks.on_stream_message = on_conn_stream_message;
  TirtcAudioOutputObserver audio_output_observer{};
  audio_output_observer.on_state_changed = on_audio_output_state_changed;
  audio_output_observer.on_error = on_audio_output_error;
  TirtcVideoOutputObserver video_output_observer{};
  video_output_observer.on_state_changed = on_video_output_state_changed;
  video_output_observer.on_error = on_video_output_error;

  if (!context->request.bootstrap_path.empty()) {
    start_stage(context, "bootstrap");
    const std::string bootstrap_event = emit_event(
        context, "info", "bootstrap", "bootstrap.read.done",
        "{\"bootstrap_id\":\"" + json_escape(context->request.bootstrap_id) + "\",\"path\":\"" +
            json_escape(context->request.bootstrap_path) + "\",\"remote_id\":\"" +
            json_escape(context->request.remote_id) + "\",\"audio_stream_id\":" +
            std::to_string(static_cast<int>(context->request.audio_stream_id)) +
            ",\"video_stream_id\":" +
            std::to_string(static_cast<int>(context->request.video_stream_id)) + "}");
    finish_stage(context, "bootstrap", StageResult::Passed, "ok", bootstrap_event);
  }

  if (tirtc_conn_create(nullptr, &connection) != TIRTC_ERROR_OK || connection == nullptr ||
      tirtc_conn_set_callbacks(connection, &conn_callbacks, &conn_callback_context) !=
          TIRTC_ERROR_OK ||
      tirtc_audio_output_create(&audio_output) != TIRTC_ERROR_OK || audio_output == nullptr ||
      tirtc_video_output_create(&video_output) != TIRTC_ERROR_OK || video_output == nullptr ||
      tirtc_audio_output_set_observer(audio_output, &audio_output_observer, &output_events) !=
          TIRTC_ERROR_OK ||
      tirtc_video_output_set_observer(video_output, &video_output_observer, &output_events) !=
          TIRTC_ERROR_OK ||
      tirtc_audio_aout_create_headless_capture(&aout_options, &aout) != TIRTC_ERROR_OK ||
      aout == nullptr ||
      tirtc_video_vout_create_headless_capture(&vout_options, &vout) != TIRTC_ERROR_OK ||
      vout == nullptr || tirtc_audio_output_set_aout(audio_output, aout) != TIRTC_ERROR_OK ||
      tirtc_video_output_attach_view(video_output, vout) != TIRTC_ERROR_OK ||
      tirtc_audio_output_attach(audio_output, connection, context->request.audio_stream_id) !=
          TIRTC_ERROR_OK ||
      tirtc_video_output_attach(video_output, connection, context->request.video_stream_id) !=
          TIRTC_ERROR_OK) {
    context->reason_code = "output_sink_unavailable";
    const std::string event_id = emit_event(
        context, "error", "output", "preflight.failed",
        "{\"reason_code\":\"output_sink_unavailable\",\"detail\":\"create output failed\"}");
    finish_stage(context, "output", StageResult::Failed, "output_sink_unavailable", event_id);
    (void)upload_logs_on_failure(context);
    cleanup_receive(connection, audio_output, video_output, aout, vout);
    return false;
  }

  start_stage(context, "connect");
  TirtcConnConnectOptions connect_options{};
  connect_options.remote_id = context->request.remote_id.c_str();
  connect_options.token = context->request.token.c_str();
  if (tirtc_conn_connect(connection, &connect_options) != TIRTC_ERROR_OK) {
    context->reason_code = "connect_failed";
    const std::string event_id =
        emit_event(context, "error", "connection", "connection.connect.failed",
                   "{\"remote_id\":\"" + json_escape(context->request.remote_id) +
                       "\",\"reason_code\":\"connect_failed\",\"elapsed_ms\":0}");
    finish_stage(context, "connect", StageResult::Failed, "connect_failed", event_id);
    (void)upload_logs_on_failure(context);
    cleanup_receive(connection, audio_output, video_output, aout, vout);
    return false;
  }
  if (!wait_until(context->request.connect_timeout_ms,
                  [&]() { return connection_events.connected.load() != 0; })) {
    context->reason_code = "connect_timeout";
    const std::string event_id =
        emit_event(context, "error", "connection", "connection.connect.failed",
                   "{\"remote_id\":\"" + json_escape(context->request.remote_id) +
                       "\",\"reason_code\":\"connect_timeout\",\"elapsed_ms\":" +
                       std::to_string(context->request.connect_timeout_ms) + "}");
    finish_stage(context, "connect", StageResult::Failed, "connect_timeout", event_id);
    (void)upload_logs_on_failure(context);
    cleanup_receive(connection, audio_output, video_output, aout, vout);
    return false;
  }
  const std::string connect_event = emit_event(
      context, "info", "connection", "connection.connect.done",
      "{\"remote_id\":\"" + json_escape(context->request.remote_id) + "\",\"elapsed_ms\":0}");
  finish_stage(context, "connect", StageResult::Passed, "ok", connect_event);

  start_stage(context, "media_receive");
  start_stage(context, "key_frame");
  start_stage(context, "decode");
  start_stage(context, "output");
  if (context->request.require_control_probe) {
    start_stage(context, "control_probe");
  }
  TirtcAudioOutputDebugSnapshot audio_debug_snapshot{};
  TirtcVideoOutputDebugSnapshot video_debug_snapshot{};
  const auto audio_ready = [&]() {
    if (!context->request.require_audio) {
      return true;
    }
    if (!load_headless_audio_capture(&audio_context)) {
      return false;
    }
    if (tirtc_audio_output_get_debug_snapshot(audio_output, &audio_debug_snapshot) !=
        TIRTC_ERROR_OK) {
      return false;
    }
    return audio_debug_snapshot.codec != TIRTC_MEDIA_CODEC_NONE &&
           audio_debug_snapshot.sample_rate_hz > 0 && audio_debug_snapshot.channels > 0;
  };
  const auto video_codec_label = [&]() {
    TirtcVideoOutputDebugSnapshot snapshot{};
    if (tirtc_video_output_get_debug_snapshot(video_output, &snapshot) != TIRTC_ERROR_OK) {
      return std::string();
    }
    video_debug_snapshot = snapshot;
    return codec_label_for_runtime_codec(snapshot.codec);
  };
  const auto control_probe_ready = [&]() {
    return !context->request.require_control_probe ||
           (context->stream_message_received.load() >= 1 &&
            context->command_echo_echoed.load() >= 1);
  };
  const auto frame_ready = [&]() {
    if (!load_headless_frame_dump(&frame_context)) {
      return false;
    }
    if (frame_context.first_frame_ms < 0) {
      frame_context.first_frame_ms = elapsed_ms_since_start(context);
    }
    return true;
  };
  (void)wait_until(context->request.first_output_timeout_ms, [&]() {
    drain_pending_command_echoes(context);
    return (frame_ready() && audio_ready()) || output_events.failed.load() != 0;
  });
  drain_pending_command_echoes(context);
  (void)frame_ready();
  const bool received_audio = audio_ready();
  const bool received_video = frame_context.frames.load() >= context->request.frame_limit;
  bool received_control_probe = control_probe_ready();
  if (received_video && received_audio && output_events.failed.load() == 0) {
    if (context->request.duration_ms > 0) {
      const int remaining_ms = context->request.duration_ms - elapsed_ms_since_start(context);
      if (remaining_ms > 0) {
        (void)wait_until(remaining_ms, [&]() {
          drain_pending_command_echoes(context);
          (void)frame_ready();
          (void)audio_ready();
          received_control_probe = control_probe_ready();
          return false;
        });
      }
      drain_pending_command_echoes(context);
      (void)frame_ready();
      (void)audio_ready();
    }
    received_control_probe = control_probe_ready();
    context->decoded_video_frame_count = frame_context.frames.load();
    context->output_consumer = "frame_dump";
    const std::string actual_video_codec = video_codec_label();
    context->actual_video_codec =
        actual_video_codec.empty() ? context->request.video_codec : actual_video_codec;
    const int first_frame_ms = frame_context.first_frame_ms >= 0 ? frame_context.first_frame_ms
                                                                 : elapsed_ms_since_start(context);
    context->first_video_packet_ms = first_frame_ms;
    context->first_key_frame_ms = first_frame_ms;
    context->first_decoded_frame_ms = first_frame_ms;
    context->first_rendered_frame_ms = first_frame_ms;
    const std::filesystem::path packet_index_path =
        codec_packets_path(context->asset_root, context->request.video_codec);
    const PacketEntry receive_packet = select_receive_packet_evidence(packet_index_path, false);
    const PacketEntry key_frame_packet = select_receive_packet_evidence(packet_index_path, true);
    const std::string raw_path = frame_context.first_frame_raw_path.empty()
                                     ? (frame_context.render_dir / "first-video-frame.raw").string()
                                     : frame_context.first_frame_raw_path.string();
    const std::string metadata_path =
        frame_context.first_frame_metadata_path.empty()
            ? (frame_context.render_dir / "first-video-frame.json").string()
            : frame_context.first_frame_metadata_path.string();
    const std::string stream_id =
        std::to_string(static_cast<int>(context->request.video_stream_id));
    const std::string codec = json_escape(context->actual_video_codec);
    const std::string receive_pts_us = std::to_string(receive_packet.pts_us);
    const std::string receive_bytes = std::to_string(receive_packet.size);
    const std::string key_frame_pts_us = std::to_string(key_frame_packet.pts_us);
    const std::string key_frame_bytes = std::to_string(key_frame_packet.size);
    const std::string frame_pts_us = std::to_string(frame_context.first_frame_pts_us);
    const std::string width = std::to_string(frame_context.first_frame_width);
    const std::string height = std::to_string(frame_context.first_frame_height);
    const std::string pixel_format = json_escape(frame_context.first_frame_pixel_format);
    if (context->request.require_audio) {
      const uint64_t estimated_packets = audio_context.captured_bytes / kEstimatedPcmBytesPerPacket;
      context->audio_packet_count =
          static_cast<int>(estimated_packets == 0 ? 1 : estimated_packets);
      context->audio_bytes = audio_context.captured_bytes;
      context->first_audio_packet_ms = audio_context.first_output_ms;
      context->first_audio_output_ms = audio_context.first_output_ms;
      if (audio_debug_snapshot.codec == TIRTC_MEDIA_CODEC_AUDIO_AAC) {
        context->request.audio_codec = "aac";
      } else if (audio_debug_snapshot.codec == TIRTC_MEDIA_CODEC_AUDIO_G711A) {
        context->request.audio_codec = "g711a";
      }
      context->request.audio_sample_rate_hz = audio_debug_snapshot.sample_rate_hz;
      context->request.audio_channels = audio_debug_snapshot.channels;
    }
    const std::string receive_event_id = emit_event(
        context, "info", "media", "media.video_receive.first_packet",
        "{\"stream_id\":" + stream_id + ",\"codec\":\"" + codec +
            "\",\"pts_us\":" + receive_pts_us + ",\"bytes\":" + receive_bytes +
            ",\"is_key_frame\":" + (receive_packet.is_key_frame ? "true" : "false") + "}");
    const std::string key_frame_event_id =
        emit_event(context, "info", "media", "media.video_receive.first_key_frame",
                   "{\"stream_id\":" + stream_id + ",\"codec\":\"" + codec +
                       "\",\"pts_us\":" + key_frame_pts_us + ",\"bytes\":" + key_frame_bytes + "}");
    const std::string decode_event_id =
        emit_event(context, "info", "decode", "decode.video.first_frame",
                   "{\"stream_id\":" + stream_id + ",\"codec\":\"" + codec +
                       "\",\"width\":" + width + ",\"height\":" + height + ",\"pixel_format\":\"" +
                       pixel_format + "\",\"pts_us\":" + frame_pts_us + "}");
    const std::string output_event_id =
        emit_event(context, "info", "output", "output.frame_dump.first_frame",
                   "{\"stream_id\":" + stream_id + ",\"raw_path\":\"" + json_escape(raw_path) +
                       "\",\"metadata_path\":\"" + json_escape(metadata_path) +
                       "\",\"width\":" + width + ",\"height\":" + height + ",\"pixel_format\":\"" +
                       pixel_format + "\",\"pts_us\":" + frame_pts_us + "}");
    if (context->request.require_audio) {
      (void)emit_event(
          context, "info", "output", "output.audio_headless.first_output",
          "{\"stream_id\":" + std::to_string(static_cast<int>(context->request.audio_stream_id)) +
              ",\"codec\":\"" + json_escape(context->request.audio_codec) +
              "\",\"sample_rate_hz\":" + std::to_string(context->request.audio_sample_rate_hz) +
              ",\"channels\":" + std::to_string(context->request.audio_channels) +
              ",\"captured_bytes\":" + std::to_string(audio_context.captured_bytes) +
              ",\"first_output_ms\":" + std::to_string(audio_context.first_output_ms) + "}");
    }
    finish_stage(context, "media_receive", StageResult::Passed, "ok", receive_event_id);
    finish_stage(context, "key_frame", StageResult::Passed, "ok", key_frame_event_id);
    finish_stage(context, "decode", StageResult::Passed, "ok", decode_event_id);
    finish_stage(context, "output", StageResult::Passed, "ok", output_event_id);
    if (context->request.require_control_probe) {
      if (received_control_probe) {
        finish_stage(context, "control_probe", StageResult::Passed, "ok", "");
      } else {
        context->reason_code = "control_probe_timeout";
        const std::string event_id =
            emit_event(context, "error", "control", "control_probe.timeout",
                       "{\"reason_code\":\"control_probe_timeout\",\"command_echoed_count\":" +
                           std::to_string(context->command_echo_echoed.load()) +
                           ",\"stream_message_received_count\":" +
                           std::to_string(context->stream_message_received.load()) + "}");
        finish_stage(context, "control_probe", StageResult::Failed, "control_probe_timeout",
                     event_id);
      }
    }
  } else {
    context->reason_code = "output_sink_unavailable";
    const std::string event_id =
        emit_event(context, "error", "output", "output.frame_dump.failed",
                   "{\"reason_code\":\"output_sink_unavailable\",\"stream_id\":" +
                       std::to_string(static_cast<int>(context->request.video_stream_id)) + "}");
    finish_stage(context, "media_receive", StageResult::Failed, "output_sink_unavailable",
                 event_id);
    finish_stage(context, "key_frame", StageResult::Failed, "output_sink_unavailable", event_id);
    finish_stage(context, "decode", StageResult::Failed, "output_sink_unavailable", event_id);
    finish_stage(context, "output", StageResult::Failed, "output_sink_unavailable", event_id);
  }

  if (context->decoded_video_frame_count < context->request.frame_limit ||
      (context->request.require_audio && context->first_audio_packet_ms < 0) ||
      (context->request.require_control_probe && !received_control_probe)) {
    (void)upload_logs_on_failure(context);
  }
  cleanup_receive(connection, audio_output, video_output, aout, vout);
  return context->decoded_video_frame_count >= context->request.frame_limit &&
         (!context->request.require_audio || context->first_audio_packet_ms >= 0) &&
         (!context->request.require_control_probe || received_control_probe);
}

}  // namespace devtools_driver_probe
