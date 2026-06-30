#pragma once

#include <filesystem>
#include <string>
#include <vector>

#include "probe_common.h"

namespace devtools_driver_probe {

struct SendAssets {
  std::filesystem::path audio_path;
  std::filesystem::path video_path;
  std::filesystem::path audio_index_path;
  std::filesystem::path video_index_path;
  std::vector<PacketEntry> audio_packets;
  std::vector<PacketEntry> video_packets;
  TirtcAudioEncodedInputOptions audio_options{};
  TirtcVideoEncodedInputOptions video_options{};
  int64_t audio_track_duration_us = 0;
  int64_t video_track_duration_us = 0;
  int64_t asset_cycle_duration_us = 0;
};

bool validate_audio_packet_index(const std::filesystem::path& audio_path,
                                 const std::string& audio_codec, uint32_t sample_rate_hz,
                                 uint32_t channels, const std::vector<PacketEntry>& packets);

bool prepare_send_assets(DriverContext* context, SendAssets* assets, std::string* reason_code,
                         std::string* event_kind);

}  // namespace devtools_driver_probe
