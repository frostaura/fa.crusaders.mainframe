# Crusaders Mainframe — the court box on a Raspberry Pi (src/iot/court-pi).
#
# Two programs, both built from the court box's EXISTING sources:
#
#   court-io     the Mega's role. courtlogic + protocol (unchanged) composed
#                with linux_hal (this project): GPIO relays and buttons, the
#                I2C LCD, the UART scanner, the Unix-socket link.
#   court-brain  the ESP8266's role. court-box/src/court_bridge/main.cpp —
#                bridge 3.1.0, UNCHANGED — plus bridgelogic and the shared
#                libraries, compiled against compat/ (Arduino, WiFi, HTTP,
#                LittleFS on Linux).
#
# Nothing under ../court-box or ../shared is edited, copied or forked: this file
# names their directories and compiles them, as PlatformIO's lib_extra_dirs
# does. CMake rather than PlatformIO because the target is a Linux computer: the
# box builds itself (`cmake -B build && cmake --build build`, ~3 min on a Pi 4)
# and CI builds it on any Linux runner.
cmake_minimum_required(VERSION 3.16)
project(court_pi CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS ON) # gnu++17, as [common] in platformio.ini
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

set(IOT ${CMAKE_CURRENT_SOURCE_DIR}/..)
set(COURT ${IOT}/court-box)
set(SHARED ${IOT}/shared)

# Where config/common/secrets.h lives (court-brain refuses to build without it).
set(COURT_PI_SECRETS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/config CACHE PATH "directory holding common/secrets.h")

# The flags platformio.ini gives the two chips, by name, so the Pi runs the same
# bounds the Mega and the bridge were reviewed against.
set(COURT_COMMON_DEFS LCD_HOLD_MAX_MS=120000UL RELAY_HARD_CAP_MS=5400000UL)

add_compile_options(-Wall -Wextra)

# --- the pure libraries: every lib/*/src of court-box and shared, minus HALs --
set(PURE_LIBS
    ${COURT}/lib/courtlogic ${COURT}/lib/protocol ${COURT}/lib/court ${COURT}/lib/bridgelogic
    ${SHARED}/lib/timebase ${SHARED}/lib/hal ${SHARED}/lib/devcrypto ${SHARED}/lib/fwversion
    ${SHARED}/lib/devapi ${SHARED}/lib/eventq ${SHARED}/lib/roster ${SHARED}/lib/memcode
    ${SHARED}/lib/devlink ${SHARED}/lib/devnet)
set(PURE_INCLUDES "")
set(PURE_SOURCES "")
foreach(dir ${PURE_LIBS})
  list(APPEND PURE_INCLUDES ${dir}/include)
  file(GLOB srcs CONFIGURE_DEPENDS ${dir}/src/*.cpp)
  list(APPEND PURE_SOURCES ${srcs})
endforeach()

# One object set per program, because the two chips were built with different
# version flags and bridgelogic/courtlogic read them.
function(court_core name major minor patch extra_defs)
  add_library(${name} STATIC ${PURE_SOURCES})
  target_include_directories(${name} PUBLIC ${PURE_INCLUDES})
  target_compile_definitions(${name} PUBLIC ${COURT_COMMON_DEFS} FW_VERSION_MAJOR=${major}
                                            FW_VERSION_MINOR=${minor} FW_VERSION_PATCH=${patch} ${extra_defs})
endfunction()

# --- court-io: Mega 3.0.0 -----------------------------------------------------
court_core(court_core_io 3 0 0 "RELAY_ACTIVE_LOW=0")
file(GLOB LINUX_HAL_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/lib/linux_hal/src/*.cpp)
add_library(linux_hal STATIC ${LINUX_HAL_SOURCES})
target_include_directories(linux_hal PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/lib/linux_hal/include)
target_link_libraries(linux_hal PUBLIC court_core_io)

add_library(posix_hal_bench STATIC
            ${SHARED}/lib/posix_hal/src/ConsoleButtons.cpp ${SHARED}/lib/posix_hal/src/ConsoleDisplay.cpp
            ${SHARED}/lib/posix_hal/src/ConsoleRelay.cpp ${SHARED}/lib/posix_hal/src/ConsoleScanner.cpp
            ${SHARED}/lib/posix_hal/src/PosixClock.cpp ${SHARED}/lib/posix_hal/src/StdinLines.cpp)
target_include_directories(posix_hal_bench PUBLIC ${SHARED}/lib/posix_hal/include)
target_link_libraries(posix_hal_bench PUBLIC court_core_io)

add_executable(court-io src/court_io/main.cpp)
target_link_libraries(court-io PRIVATE linux_hal posix_hal_bench court_core_io)

# --- court-brain: bridge 3.1.0 -----------------------------------------------
court_core(court_core_brain 3 1 0
           "TARGET_COURT_BRIDGE=1;HEARTBEAT_INTERVAL_MS=30000UL;AUTH_TTL_MS=30000UL;ROSTER_MAX_AGE_MS=21600000UL;EVENTQ_SLOTS=64")
file(GLOB COMPAT_SOURCES CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/compat/src/*.cpp)
add_executable(court-brain
               ${COURT}/src/court_bridge/main.cpp ${COURT}/src/court_bridge/EspLifeline.cpp
               ${COURT}/lib/arduino_hal/src/ArduinoClock.cpp ${COURT}/lib/arduino_hal/src/LittleFsStore.cpp
               ${COURT}/lib/arduino_hal/src/SerialTransport.cpp
               ${COMPAT_SOURCES}
               ${CMAKE_CURRENT_SOURCE_DIR}/lib/linux_hal/src/UnixLink.cpp
               ${CMAKE_CURRENT_SOURCE_DIR}/lib/linux_hal/src/Service.cpp)
# compat/include FIRST so <Arduino.h> is ours; then the secrets directory (as
# PlatformIO puts src/ on the path for "common/secrets.h"); then the HALs.
target_include_directories(court-brain BEFORE PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/compat/include
                           ${COURT_PI_SECRETS_DIR} ${COURT}/lib/arduino_hal/include ${COURT}/src/court_bridge
                           ${CMAKE_CURRENT_SOURCE_DIR}/lib/linux_hal/include)
target_link_libraries(court-brain PRIVATE court_core_brain)

# --- host tests: `ctest` -------------------------------------------------------
enable_testing()
add_executable(test_court_pi test/test_court_pi.cpp
               ${CMAKE_CURRENT_SOURCE_DIR}/compat/src/Http.cpp ${CMAKE_CURRENT_SOURCE_DIR}/compat/src/BrainConfig.cpp
               ${CMAKE_CURRENT_SOURCE_DIR}/compat/src/Wifi.cpp ${CMAKE_CURRENT_SOURCE_DIR}/lib/linux_hal/src/UnixLink.cpp
               ${CMAKE_CURRENT_SOURCE_DIR}/lib/linux_hal/src/Service.cpp)
target_include_directories(test_court_pi PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/compat/include
                           ${CMAKE_CURRENT_SOURCE_DIR}/lib/linux_hal/include)
target_link_libraries(test_court_pi PRIVATE court_core_io)
add_test(NAME court_pi COMMAND test_court_pi)

install(TARGETS court-io court-brain RUNTIME DESTINATION /usr/local/bin)
