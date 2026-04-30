# Hardware Profile — RoClaw V1

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
- Module: ESP32-CAM (AI-Thinker)
- Resolution: 320x240 (QVGA)
- Frame rate: ~10 fps MJPEG
- FOV: ~65 degrees
- Interface: HTTP MJPEG stream on port 80

## Controllers
- Motor controller: ESP32-S3-DevKitC-1
- Camera: ESP32-CAM (AI-Thinker)
- Communication: WiFi UDP bytecode (port 4210)

## Safety Limits
- Max steps per command: 40960 (10 revolutions)
- Host heartbeat timeout: 2000 ms
- Max step rate: 1024 steps/s
- Emergency stop: Automatic on host timeout
