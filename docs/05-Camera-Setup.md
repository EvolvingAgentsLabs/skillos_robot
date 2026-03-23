# Camera Setup Guide

RoClaw needs an MJPEG camera stream for its vision loop. You can use either an **ESP32-CAM** module (default) or an **Android phone** running a webcam app.

## Option A: ESP32-CAM (Default)

The ESP32-CAM is a low-cost Wi-Fi camera module designed for embedded projects.

### Setup

1. Flash the ESP32-CAM with the CameraWebServer example firmware (Arduino IDE or PlatformIO).
2. Connect the ESP32-CAM to your Wi-Fi network.
3. Note the IP address printed to Serial Monitor on boot.
4. Configure `.env`:

```env
ESP32_CAM_HOST=192.168.1.101
ESP32_CAM_PORT=80
ESP32_CAM_PATH=/stream
```

The `/stream` path is the default MJPEG endpoint on ESP32-CAM firmware.

## Option B: Android Phone

Turn any Android phone into a wireless camera using an MJPEG streaming app.

### Using IP Webcam

1. Install **IP Webcam** from the Play Store.
2. Open the app, scroll to **Video preferences**:
   - Set resolution to **320x240** (keeps bandwidth low for the VLM).
   - Set video format to **MJPEG**.
3. Tap **Start server** at the bottom.
4. Note the IP address and port shown on screen.
5. Configure `.env`:

```env
ESP32_CAM_HOST=192.168.1.50
ESP32_CAM_PORT=8080
ESP32_CAM_PATH=/video
```

### Using DroidCam

1. Install **DroidCam** from the Play Store.
2. Open the app and note the IP and port.
3. Configure `.env`:

```env
ESP32_CAM_HOST=192.168.1.50
ESP32_CAM_PORT=4747
ESP32_CAM_PATH=/mjpegfeed
```

## Option C: External Overhead Camera (V1 Hardware)

In V1 the robot has **no onboard camera**. An Android phone on a tripod looks down at the entire arena, giving the VLM a bird's-eye view of the robot, obstacles, and targets.

This is an offboard perception architecture — the same pattern used in professional robotics labs. See [docs/11-Hardware-V1-Setup-Guide.md](11-Hardware-V1-Setup-Guide.md) for the complete hardware setup including ESP32-S3 wiring, motor testing, and calibration.

### Setup

1. Mount your phone on a tripod 60-90cm above the arena.
2. Angle it top-down or at ~60 degrees from horizontal.
3. Ensure the entire arena is visible at all times.
4. Install **IP Webcam** and start the server.
5. Configure `.env`:

```env
ESP32_CAM_HOST=192.168.1.50
ESP32_CAM_PORT=8080
ESP32_CAM_PATH=/video
EXTERNAL_CAMERA_MODE=overhead
```

### Test the Connection

```bash
npm run hardware:test -- --test connectivity
```

## Comparison

| Feature | ESP32-CAM | Android (Onboard) | Android (External/V1) |
|---|---|---|---|
| Cost | ~$5 | Uses existing phone | Uses existing phone |
| Resolution | Up to 1600x1200 | Up to 1920x1080 | Up to 1920x1080 |
| Setup complexity | Flash firmware | Install app | Install app + tripod |
| Extra sensors | None | Gyro, accel, GPS | Gyro, accel, GPS |
| View | First-person (robot) | First-person (robot) | Bird's-eye (overhead) |
| Full scene visible | No | No | Yes |
| Power | USB or battery | Phone battery | Phone battery |
| Form factor | Tiny, mountable | Bulky for a robot | Off-robot (tripod) |

## Quick `.env` Reference

```env
# ESP32-CAM (default)
ESP32_CAM_HOST=192.168.1.101
ESP32_CAM_PORT=80
ESP32_CAM_PATH=/stream

# Android IP Webcam
ESP32_CAM_HOST=192.168.1.50
ESP32_CAM_PORT=8080
ESP32_CAM_PATH=/video

# Android DroidCam
ESP32_CAM_HOST=192.168.1.50
ESP32_CAM_PORT=4747
ESP32_CAM_PATH=/mjpegfeed
```

## Sensor Integration (IP Webcam Only)

IP Webcam exposes phone sensors (compass, accelerometer, gyroscope, GPS) via HTTP at `/sensors.json`. This is used by RoClaw for compass heading — DroidCam does **not** provide sensor access.

### Setup

1. Open IP Webcam → **Data logging** → Enable sensor logging.
2. Start the server.
3. Verify sensors are accessible:

```bash
curl http://192.168.1.50:8080/sensors.json | jq '.orientation'
```

You should see output like:

```json
{
  "data": [[[45.2, -3.1, 0.5]]],
  "unit": "deg"
}
```

The `orientation` sensor provides `[azimuth, pitch, roll]` where **azimuth** (index 0) is the compass heading in degrees (0 = North, 90 = East, 180 = South, 270 = West).

### Configuration

Add to `.env`:

```env
IP_WEBCAM_HOST=192.168.1.50
IP_WEBCAM_PORT=8080
```

When configured, `SemanticMapLoop` uses compass heading from the phone's magnetometer to override ESP32 odometry heading, which is more accurate for absolute heading.

### Capturing Outdoor Routes

You can record a walking route with frames + compass data for E2E testing:

```bash
IP_WEBCAM_HOST=192.168.1.50 IP_WEBCAM_PORT=8080 \
  npx tsx scripts/capture-route.ts --name my-route --duration 30
```

See `__tests__/navigation/fixtures/outdoor_routes/README.md` for details.

## Troubleshooting

**"Connection refused" or timeout**
- Verify the phone/ESP32 is on the same Wi-Fi network as the machine running RoClaw.
- Check your firewall allows incoming connections on the camera port.
- Ping the camera IP to confirm reachability: `ping 192.168.1.50`

**Wrong stream path**
- Open `http://<host>:<port><path>` in a browser. You should see a live MJPEG stream.
- IP Webcam uses `/video`, DroidCam uses `/mjpegfeed`, ESP32-CAM uses `/stream`.

**Frames dropping or high latency**
- Lower the camera resolution to 320x240. The VLM doesn't need high resolution.
- Ensure no other app is consuming the stream simultaneously.
- Move closer to the Wi-Fi access point to improve signal strength.

**Stream works in browser but not in RoClaw**
- Some apps require you to keep the app in the foreground. Check the app's background streaming setting.
- Confirm the stream format is MJPEG, not RTSP or HLS.
