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

bool prepare_send_assets(DriverContext* context, SendAssets* assets, std::string* reason_code,
                         std::string* event_kind);

}  // namespace devtools_driver_probe
