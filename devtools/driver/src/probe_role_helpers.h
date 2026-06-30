#pragma once

#include <functional>

#include "probe_common.h"

namespace devtools_driver_probe {

void on_service_started(TirtcConnService* service, void* user_data);
void on_service_stopped(TirtcConnService* service, void* user_data);
void on_service_connected(TirtcConnService* service, TirtcConn* connection, void* user_data);
void on_service_error(TirtcConnService* service, TirtcError error, const char* message,
                      void* user_data);

void on_conn_state_changed(TirtcConn* connection, TirtcConnState state, TirtcError error,
                           void* user_data);
void on_conn_command_echo(TirtcConn* connection, uint32_t command, TirtcOwnedBytes* owned_payload,
                          void* user_data);
void drain_pending_command_echoes(DriverContext* context);
void on_conn_stream_message(TirtcConn* connection, uint8_t stream_id, uint32_t timestamp_ms,
                            TirtcOwnedBytes* owned_payload, void* user_data);
void on_audio_output_state_changed(TirtcAudioOutput* output, TirtcAudioOutputState state,
                                   void* user_data);
void on_audio_output_error(TirtcAudioOutput* output, TirtcError error,
                           TirtcOwnedString* owned_message, void* user_data);
void on_video_output_state_changed(TirtcVideoOutput* output, TirtcVideoOutputState state,
                                   void* user_data);
void on_video_output_error(TirtcVideoOutput* output, TirtcError error,
                           TirtcOwnedString* owned_message, void* user_data);

bool load_headless_audio_capture(AudioCaptureContext* context);
bool load_headless_frame_dump(FrameDumpContext* context);
void pump_platform_events_once();
bool wait_until(int timeout_ms, const std::function<bool()>& predicate);
void cleanup_receive(TirtcConn* connection, TirtcAudioOutput* audio_output,
                     TirtcVideoOutput* video_output, TirtcAudioAout* aout, TirtcVideoVout* vout);

}  // namespace devtools_driver_probe
