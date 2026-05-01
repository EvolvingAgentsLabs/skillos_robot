# Hardware Profile — RoClaw V2

## Chassis
- Form factor: 20cm x 20cm cube
- Material: 3D-printed PLA
- 3D print weight: <200g

## Motors
- Type: 28BYJ-48 stepper motors (x2)
- Steps per revolution: 4096 (64:1 gear ratio)
- Max speed: 1024 steps/s (~15 RPM)
- Current draw: ~240mA per coil
- Driver: ULN2003 Darlington array (x2)

## Wheels
- Diameter: 6.0 cm
- Circumference: 18.85 cm
- Steps per cm: 217.3
- Max linear speed: 4.71 cm/s
- Wheel base: 10.0 cm

## Camera
- Module: ESP32-S3-CAM (integrated on controller board)
- Sensor: OV2640
- Resolution: 320x240 (QVGA)
- Frame rate: ~20 fps MJPEG
- FOV: ~65 degrees
- Interface: HTTP MJPEG stream on port 80

## Controller (Unified — V2)
- Board: ESP32-S3-CAM (single board, replaces dual-ESP V1)
- CPU: Xtensa LX7 dual-core @ 240 MHz
- RAM: 512 KB SRAM + 8 MB PSRAM (camera frame buffers)
- GPIO: 15 of 35 used (camera bus + motors + I2C + LED)
- Firmware: `firmware/roclaw_unified/` (FreeRTOS, 3 tasks)
- Communication: WiFi UDP (motor :4210), HTTP (MJPEG :80, telemetry :4220)

## IMU / Self-Perception (V2)
- Sensor: MPU-6050 (accelerometer + gyroscope)
- Interface: I2C (SDA=GPIO1, SCL=GPIO2)
- Accel range: ±2g (16384 LSB/g)
- Gyro range: ±250 deg/s (131 LSB/deg/s)
- Read rate: 50 Hz
- Self-perception loops:
  - Locomotion: motor command → accelerometer verification
  - Heading: gyroscope integration (dead reckoning)

## Network Ports
- UDP 4210: Motor bytecode commands (6-byte frames)
- HTTP 80: MJPEG camera stream (/stream)
- HTTP 4220: Telemetry JSON endpoint (/telemetry)

## Safety Limits
- Max steps per command: 40960 (10 revolutions)
- Host heartbeat timeout: 2000 ms
- Max step rate: 1024 steps/s
- Emergency stop: Automatic on host timeout
- STOP command resets emergency state

## V2.1 Camera-Only Variant (Egocentric)
- Firmware: `firmware/roclaw_egocentric/` (FreeRTOS, 2 tasks)
- No IMU: MPU-6050 removed — visual servoing replaces inertial navigation
- Tasks: Camera (Core 0), Motor (Core 1) — no sensor task
- Control: First-person visual servoing via EgocentricController
- Telemetry: Step counts only (`/telemetry` → `{"steps":{"left":N,"right":N},"safety":{...}}`)
- GPIO: Camera bus + motor pins only (no I2C required)
- Minimum hardware: ESP32-S3-CAM + 2x 28BYJ-48 + 2x ULN2003

## V1 Hardware (Deprecated)
- Motor controller: ESP32-S3-DevKitC-1 (separate from camera)
- Camera: ESP32-CAM AI-Thinker (separate board)
- Two-board architecture replaced by single ESP32-S3-CAM in V2
