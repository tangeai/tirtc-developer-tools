#include "probe_send_session.h"

#include <algorithm>
#include <system_error>

namespace devtools_driver_probe {
namespace {

constexpr int kReadAllPackets = 0;
constexpr int64_t kDefaultAudioPacketDurationUs = 40000;
constexpr int64_t kDefaultVideoPacketDurationUs = 66667;

int64_t infer_packet_interval_us(const std::vector<PacketEntry>& packets,
                                 int64_t fallback_interval_us) {
  if (packets.size() >= 2 && packets[1].pts_us > packets[0].pts_us) {
    return packets[1].pts_us - packets[0].pts_us;
  }
  return fallback_interval_us;
}

int64_t track_loop_duration_us(const std::vector<PacketEntry>& packets,
                               int64_t fallback_interval_us) {
  if (packets.empty()) {
    return fallback_interval_us;
  }
  const int64_t interval_us = infer_packet_interval_us(packets, fallback_interval_us);
  return packets.back().pts_us + interval_us;
}

bool validate_audio_packet_index(const std::filesystem::path& audio_path,
                                 const std::string& audio_codec, uint32_t channels,
                                 const std::vector<PacketEntry>& packets) {
  std::error_code error;
  const uintmax_t audio_bytes = std::filesystem::file_size(audio_path, error);
  if (error || packets.empty()) {
    return false;
  }
  for (const PacketEntry& packet : packets) {
    if (packet.size == 0 || packet.samples_per_channel == 0) {
      return false;
    }
    if (packet.offset > audio_bytes || packet.size > audio_bytes - packet.offset) {
      return false;
    }
    if (audio_codec == "g711a" &&
        packet.size != static_cast<size_t>(packet.samples_per_channel) * channels) {
      return false;
    }
    if (audio_codec == "aac" && packet.samples_per_channel != 1024) {
      return false;
    }
  }
  return true;
}

}  // namespace

bool prepare_send_assets(DriverContext* context, SendAssets* assets, std::string* reason_code,
                         std::string* event_kind) {
  if (context == nullptr || assets == nullptr || reason_code == nullptr || event_kind == nullptr) {
    return false;
  }

  assets->audio_options.codec = audio_codec_to_runtime_codec(context->request.audio_codec);
  assets->audio_options.sample_rate_hz = context->request.audio_sample_rate_hz;
  assets->audio_options.channels = context->request.audio_channels;
  assets->video_options.codec = codec_to_runtime_codec(context->request.video_codec);
  assets->video_options.bitstream_format = codec_to_bitstream_format(context->request.video_codec);

  std::filesystem::path asset_root_for_codec = context->asset_root;
  std::filesystem::path media_path =
      codec_media_path(context->asset_root, context->request.video_codec);
  if (!context->request.media_source_path.empty()) {
    const std::filesystem::path source_path(context->request.media_source_path);
    if (std::filesystem::is_directory(source_path)) {
      asset_root_for_codec = source_path;
      media_path = codec_media_path(source_path.string(), context->request.video_codec);
    } else if (source_path.filename() == "manifest.json") {
      asset_root_for_codec = source_path.parent_path();
      media_path = codec_media_path(asset_root_for_codec.string(), context->request.video_codec);
    } else {
      media_path = source_path;
      if (source_path.parent_path().filename() == "video") {
        asset_root_for_codec = source_path.parent_path().parent_path();
      }
    }
  }

  assets->video_index_path =
      codec_packets_path(asset_root_for_codec.string(), context->request.video_codec);
  assets->audio_path =
      audio_media_path(asset_root_for_codec.string(), context->request.audio_codec,
                       context->request.audio_sample_rate_hz, context->request.audio_channels);
  assets->audio_index_path =
      audio_packets_path(asset_root_for_codec.string(), context->request.audio_codec,
                         context->request.audio_sample_rate_hz, context->request.audio_channels);
  assets->video_path = media_path;
  context->media_path = media_path.string();
  context->audio_asset_key =
      audio_track_key(context->request.audio_codec, context->request.audio_sample_rate_hz,
                      context->request.audio_channels);
  context->audio_media_path = assets->audio_path.string();
  context->video_media_path = media_path.string();

  if (!std::filesystem::exists(assets->audio_path) ||
      !std::filesystem::exists(assets->audio_index_path)) {
    *reason_code = "audio_asset_missing";
    *event_kind = "media.audio_send.asset_missing";
    return false;
  }
  if (!std::filesystem::exists(assets->video_path) ||
      !std::filesystem::exists(assets->video_index_path)) {
    *reason_code = "asset_missing";
    *event_kind = "media.send.asset_missing";
    return false;
  }

  assets->audio_packets = read_audio_packets(assets->audio_index_path, kReadAllPackets);
  assets->video_packets = read_packets(assets->video_index_path, kReadAllPackets);
  if (!validate_audio_packet_index(assets->audio_path, context->request.audio_codec,
                                   context->request.audio_channels, assets->audio_packets)) {
    *reason_code = "audio_packet_index_invalid";
    *event_kind = "media.audio_send.packet_index_invalid";
    return false;
  }
  if (assets->video_packets.empty()) {
    *reason_code = "asset_missing";
    *event_kind = "media.send.asset_missing";
    return false;
  }

  assets->audio_track_duration_us =
      track_loop_duration_us(assets->audio_packets, kDefaultAudioPacketDurationUs);
  assets->video_track_duration_us =
      track_loop_duration_us(assets->video_packets, kDefaultVideoPacketDurationUs);
  assets->asset_cycle_duration_us =
      std::min(assets->audio_track_duration_us, assets->video_track_duration_us);
  if (assets->asset_cycle_duration_us <= 0) {
    *reason_code = "asset_missing";
    *event_kind = "media.send.asset_missing";
    return false;
  }
  return true;
}

}  // namespace devtools_driver_probe
