#pragma once

#include "probe_common.h"

namespace devtools_driver_probe {

bool run_system_send_role(DriverContext* context, TirtcConnService* service,
                          ServiceContext* service_context);

}  // namespace devtools_driver_probe
