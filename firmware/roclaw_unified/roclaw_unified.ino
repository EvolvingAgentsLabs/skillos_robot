/**
 * RoClaw Unified Firmware — Single ESP32-S3-CAM Board
 *
 * Consolidates the dual-ESP architecture (esp32_cam_eyes + esp32_s3_spinal_cord)
 * into a single ESP32-S3-CAM running three FreeRTOS tasks:
 *
 *   Task 1: MJPEG Server      — Camera capture + HTTP streaming (Core 0)
 *   Task 2: UDP Motor Listener — 6-byte frame → stepper control (Core 1)
 *   Task 3: Sensor Reader      — MPU-6050 I2C → telemetry response (Core 1)
 *
 * Hardware: ESP32-S3-CAM (OV2640 camera + GPIO for steppers + I2C for MPU-6050)
 * Protocol: UDP :4210 (motor), HTTP :80 (MJPEG stream), HTTP :4220 (telemetry)
 *
 * GPIO Allocation (15 of 35 used):
 *   Camera: GPIO 4,5,6,7,15,16,17,18 (OV2640 data bus — varies by board)
 *   Motor L: GPIO 35,36,37,38 (ULN2003 #1)
 *   Motor R: GPIO 39,40,41,42 (ULN2003 #2)
 *   I2C:     GPIO 1 (SDA), GPIO 2 (SCL)
 *   Status:  GPIO 48 (built-in LED)
 *
 * Self-Perception Loops (embodiment reformulation):
 *   1. Locomotion: motor command → MPU-6050 accelerometer verify
 *   2. Haptic:     motor stall → current sensing (future: INA219)
 *   3. Audio:      buzzer → microphone verify (future: I2S PDM)
 */

#include <WiFi.h>
#include <WiFiUdp.h>
#include <WebServer.h>
#include <Wire.h>
#include <AccelStepper.h>
#include "esp_camera.h"

// =============================================================================
// Configuration
// =============================================================================

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// Network ports
#define UDP_MOTOR_PORT    4210
#define HTTP_MJPEG_PORT   80
#define HTTP_TELEMETRY_PORT 4220

// I2C (MPU-6050)
#define I2C_SDA  1
#define I2C_SCL  2
#define MPU6050_ADDR 0x68

// Motor pins (ULN2003 × 2) — positioned on S3's high-number GPIOs
// to avoid conflicts with camera data bus
#define LEFT_IN1   35
#define LEFT_IN2   36
#define LEFT_IN3   37
#define LEFT_IN4   38
#define RIGHT_IN1  39
#define RIGHT_IN2  40
#define RIGHT_IN3  41
#define RIGHT_IN4  42

// Status LED
#define STATUS_LED 48

// 28BYJ-48 constants
#define STEPS_PER_REV     4096
#define WHEEL_DIAMETER_CM 6.0
#define WHEEL_BASE_CM     10.0
#define MAX_SPEED_SPS     1024

// Safety
#define HOST_HEARTBEAT_MS 2000
#define MAX_CONTINUOUS_STEPS 40960

// Camera (ESP32-S3-CAM board — adjust for your specific board variant)
#define CAM_PIN_PWDN    -1
#define CAM_PIN_RESET   -1
#define CAM_PIN_XCLK    10
#define CAM_PIN_SIOD    3
#define CAM_PIN_SIOC    4
#define CAM_PIN_D7      5
#define CAM_PIN_D6      6
#define CAM_PIN_D5      7
#define CAM_PIN_D4      15
#define CAM_PIN_D3      16
#define CAM_PIN_D2      17
#define CAM_PIN_D1      18
#define CAM_PIN_D0      8
#define CAM_PIN_VSYNC   46
#define CAM_PIN_HREF    9
#define CAM_PIN_PCLK    11

// =============================================================================
// Protocol (shared with TypeScript BytecodeCompiler)
// =============================================================================

#define FRAME_START     0xAA
#define FRAME_END       0xFF
#define FRAME_LEN       6

#define OP_MOVE_FORWARD  0x01
#define OP_MOVE_BACKWARD 0x02
#define OP_TURN_LEFT     0x03
#define OP_TURN_RIGHT    0x04
#define OP_ROTATE_CW     0x05
#define OP_ROTATE_CCW    0x06
#define OP_STOP          0x07
#define OP_GET_STATUS    0x08
#define OP_MOVE_STEPS    0x09
#define OP_MOVE_STEPS_R  0x0A

// =============================================================================
// Global State
// =============================================================================

AccelStepper stepperL(AccelStepper::HALF4WIRE, LEFT_IN1, LEFT_IN3, LEFT_IN2, LEFT_IN4);
AccelStepper stepperR(AccelStepper::HALF4WIRE, RIGHT_IN1, RIGHT_IN3, RIGHT_IN2, RIGHT_IN4);

WiFiUDP udp;
WebServer mjpegServer(HTTP_MJPEG_PORT);
WebServer telemetryServer(HTTP_TELEMETRY_PORT);

// Pose tracking (dead reckoning)
volatile float posX = 0.0, posY = 0.0, headingDeg = 0.0;

// MPU-6050 data
volatile float accelX = 0, accelY = 0, accelZ = 0;
volatile float gyroX = 0, gyroY = 0, gyroZ = 0;

// Safety
volatile unsigned long lastCommandTime = 0;
volatile bool emergencyStopped = false;

// Self-perception: last command vs measured response
volatile uint8_t lastOpcode = OP_STOP;
volatile bool motionVerified = false;

// Task handles
TaskHandle_t motorTaskHandle = NULL;
TaskHandle_t sensorTaskHandle = NULL;

// =============================================================================
// Camera Init
// =============================================================================

bool initCamera() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = CAM_PIN_D0;
  config.pin_d1 = CAM_PIN_D1;
  config.pin_d2 = CAM_PIN_D2;
  config.pin_d3 = CAM_PIN_D3;
  config.pin_d4 = CAM_PIN_D4;
  config.pin_d5 = CAM_PIN_D5;
  config.pin_d6 = CAM_PIN_D6;
  config.pin_d7 = CAM_PIN_D7;
  config.pin_xclk = CAM_PIN_XCLK;
  config.pin_pclk = CAM_PIN_PCLK;
  config.pin_vsync = CAM_PIN_VSYNC;
  config.pin_href = CAM_PIN_HREF;
  config.pin_sccb_sda = CAM_PIN_SIOD;
  config.pin_sccb_scl = CAM_PIN_SIOC;
  config.pin_pwdn = CAM_PIN_PWDN;
  config.pin_reset = CAM_PIN_RESET;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_QVGA;  // 320x240
  config.jpeg_quality = 12;
  config.fb_count = 2;
  config.fb_location = CAMERA_FB_IN_PSRAM;
  config.grab_mode = CAMERA_GRAB_LATEST;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
    return false;
  }
  return true;
}

// =============================================================================
// MJPEG Stream Handler (Task 1 — Core 0)
// =============================================================================

void handleMJPEGStream() {
  WiFiClient client = mjpegServer.client();
  String boundary = "roclaw_frame";

  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: multipart/x-mixed-replace; boundary=" + boundary);
  client.println();

  while (client.connected()) {
    camera_fb_t* fb = esp_camera_fb_get();
    if (!fb) {
      delay(10);
      continue;
    }

    client.println("--" + boundary);
    client.println("Content-Type: image/jpeg");
    client.printf("Content-Length: %d\r\n\r\n", fb->len);
    client.write(fb->buf, fb->len);
    client.println();

    esp_camera_fb_return(fb);
    delay(50);  // ~20fps cap
  }
}

// =============================================================================
// MPU-6050 Init & Read (Task 3)
// =============================================================================

bool initMPU6050() {
  Wire.begin(I2C_SDA, I2C_SCL);

  // Wake up MPU-6050
  Wire.beginTransmission(MPU6050_ADDR);
  Wire.write(0x6B);  // PWR_MGMT_1
  Wire.write(0x00);  // Clear sleep bit
  Wire.endTransmission(true);
  delay(100);

  // Verify device ID
  Wire.beginTransmission(MPU6050_ADDR);
  Wire.write(0x75);  // WHO_AM_I
  Wire.endTransmission(false);
  Wire.requestFrom(MPU6050_ADDR, 1);
  uint8_t whoAmI = Wire.read();

  if (whoAmI != 0x68 && whoAmI != 0x98) {
    Serial.printf("MPU-6050 not found (WHO_AM_I=0x%02X)\n", whoAmI);
    return false;
  }

  // Set accelerometer range: ±2g
  Wire.beginTransmission(MPU6050_ADDR);
  Wire.write(0x1C);
  Wire.write(0x00);
  Wire.endTransmission(true);

  // Set gyro range: ±250 deg/s
  Wire.beginTransmission(MPU6050_ADDR);
  Wire.write(0x1B);
  Wire.write(0x00);
  Wire.endTransmission(true);

  Serial.println("MPU-6050 initialized");
  return true;
}

void readMPU6050() {
  Wire.beginTransmission(MPU6050_ADDR);
  Wire.write(0x3B);  // Start at ACCEL_XOUT_H
  Wire.endTransmission(false);
  Wire.requestFrom(MPU6050_ADDR, 14);

  int16_t rawAx = (Wire.read() << 8) | Wire.read();
  int16_t rawAy = (Wire.read() << 8) | Wire.read();
  int16_t rawAz = (Wire.read() << 8) | Wire.read();
  Wire.read(); Wire.read();  // Temperature (skip)
  int16_t rawGx = (Wire.read() << 8) | Wire.read();
  int16_t rawGy = (Wire.read() << 8) | Wire.read();
  int16_t rawGz = (Wire.read() << 8) | Wire.read();

  // Convert to physical units
  accelX = rawAx / 16384.0;  // ±2g → g
  accelY = rawAy / 16384.0;
  accelZ = rawAz / 16384.0;
  gyroX = rawGx / 131.0;     // ±250 deg/s
  gyroY = rawGy / 131.0;
  gyroZ = rawGz / 131.0;
}

// =============================================================================
// Self-Perception: Locomotion Verification
// =============================================================================

/**
 * Verify that the robot is actually moving after a motor command.
 * Compares MPU-6050 acceleration magnitude against a threshold.
 * This is the "locomotion self-perception loop" from embodiment reformulation.
 */
bool verifyMotion() {
  float accelMag = sqrt(accelX * accelX + accelY * accelY + accelZ * accelZ);
  // When stationary, magnitude ≈ 1.0g (gravity only)
  // When moving, vibrations/acceleration add noise > threshold
  const float MOTION_THRESHOLD = 1.05;  // 5% above gravity = motion detected
  return accelMag > MOTION_THRESHOLD || accelMag < 0.95;
}

// =============================================================================
// Motor Command Execution
// =============================================================================

void executeCommand(uint8_t opcode, uint8_t paramL, uint8_t paramR) {
  lastCommandTime = millis();
  lastOpcode = opcode;

  if (emergencyStopped && opcode != OP_STOP && opcode != OP_GET_STATUS) {
    return;
  }

  int speedL = map(paramL, 0, 255, 0, MAX_SPEED_SPS);
  int speedR = map(paramR, 0, 255, 0, MAX_SPEED_SPS);

  switch (opcode) {
    case OP_MOVE_FORWARD:
      stepperL.setMaxSpeed(speedL);
      stepperR.setMaxSpeed(speedR);
      stepperL.move(MAX_CONTINUOUS_STEPS);
      stepperR.move(-MAX_CONTINUOUS_STEPS);  // Right motor mirrored
      break;

    case OP_MOVE_BACKWARD:
      stepperL.setMaxSpeed(speedL);
      stepperR.setMaxSpeed(speedR);
      stepperL.move(-MAX_CONTINUOUS_STEPS);
      stepperR.move(MAX_CONTINUOUS_STEPS);
      break;

    case OP_TURN_LEFT:
      stepperL.setMaxSpeed(speedL);
      stepperR.setMaxSpeed(speedR);
      stepperL.move(speedL);       // Slow left
      stepperR.move(-speedR * 2);  // Fast right
      break;

    case OP_TURN_RIGHT:
      stepperL.setMaxSpeed(speedL);
      stepperR.setMaxSpeed(speedR);
      stepperL.move(speedL * 2);   // Fast left
      stepperR.move(-speedR);      // Slow right
      break;

    case OP_ROTATE_CW:
      stepperL.setMaxSpeed(speedR);
      stepperR.setMaxSpeed(speedR);
      stepperL.move((long)paramL * STEPS_PER_REV / 360);
      stepperR.move((long)paramL * STEPS_PER_REV / 360);  // Same direction = rotate
      break;

    case OP_ROTATE_CCW:
      stepperL.setMaxSpeed(speedR);
      stepperR.setMaxSpeed(speedR);
      stepperL.move(-(long)paramL * STEPS_PER_REV / 360);
      stepperR.move(-(long)paramL * STEPS_PER_REV / 360);
      break;

    case OP_STOP:
      stepperL.stop();
      stepperR.stop();
      stepperL.setCurrentPosition(stepperL.currentPosition());
      stepperR.setCurrentPosition(stepperR.currentPosition());
      emergencyStopped = false;  // STOP resets emergency state
      break;

    case OP_MOVE_STEPS:
      stepperL.setMaxSpeed(MAX_SPEED_SPS);
      stepperR.setMaxSpeed(MAX_SPEED_SPS);
      stepperL.move((long)paramL * 16);   // paramL × 16 steps
      stepperR.move(-(long)paramR * 16);
      break;

    case OP_MOVE_STEPS_R:
      stepperL.setMaxSpeed(MAX_SPEED_SPS);
      stepperR.setMaxSpeed(MAX_SPEED_SPS);
      stepperL.move(-(long)paramL * 16);
      stepperR.move((long)paramR * 16);
      break;

    case OP_GET_STATUS:
      sendStatusResponse();
      break;
  }
}

void sendStatusResponse() {
  char json[256];
  snprintf(json, sizeof(json),
    "{\"pose\":{\"x\":%.2f,\"y\":%.2f,\"heading\":%.1f},"
    "\"imu\":{\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,\"gx\":%.1f,\"gy\":%.1f,\"gz\":%.1f},"
    "\"safety\":{\"emergency\":%s,\"lastCmd\":%lu},"
    "\"selfPerception\":{\"motionVerified\":%s,\"lastOpcode\":%d}}",
    posX, posY, headingDeg,
    accelX, accelY, accelZ, gyroX, gyroY, gyroZ,
    emergencyStopped ? "true" : "false", lastCommandTime,
    motionVerified ? "true" : "false", lastOpcode
  );
  udp.beginPacket(udp.remoteIP(), udp.remotePort());
  udp.write((uint8_t*)json, strlen(json));
  udp.endPacket();
}

// =============================================================================
// Task 2: UDP Motor Listener (Core 1)
// =============================================================================

void motorTask(void* param) {
  udp.begin(UDP_MOTOR_PORT);
  Serial.printf("UDP motor listener on port %d\n", UDP_MOTOR_PORT);

  uint8_t buf[FRAME_LEN];

  while (true) {
    // Safety heartbeat check
    if (millis() - lastCommandTime > HOST_HEARTBEAT_MS && lastOpcode != OP_STOP) {
      stepperL.stop();
      stepperR.stop();
      emergencyStopped = true;
    }

    // Run steppers
    stepperL.run();
    stepperR.run();

    // Check for UDP packets
    int packetSize = udp.parsePacket();
    if (packetSize == FRAME_LEN) {
      udp.read(buf, FRAME_LEN);

      // Validate frame
      if (buf[0] == FRAME_START && buf[5] == FRAME_END) {
        uint8_t checksum = (buf[1] + buf[2] + buf[3]) & 0xFF;
        if (checksum == buf[4]) {
          executeCommand(buf[1], buf[2], buf[3]);
        }
      }
    }

    // Yield to other tasks (but keep motor timing tight)
    vTaskDelay(1);
  }
}

// =============================================================================
// Task 3: Sensor Reader (Core 1)
// =============================================================================

void sensorTask(void* param) {
  bool mpuReady = initMPU6050();
  if (!mpuReady) {
    Serial.println("WARNING: MPU-6050 not available — self-perception disabled");
  }

  while (true) {
    if (mpuReady) {
      readMPU6050();

      // Self-perception: verify motion matches last command
      bool shouldBeMoving = (lastOpcode != OP_STOP && lastOpcode != OP_GET_STATUS);
      motionVerified = shouldBeMoving ? verifyMotion() : !verifyMotion();

      // Dead reckoning from gyro (heading only — position requires wheel encoders)
      headingDeg += gyroZ * 0.02;  // 50Hz × dt
      if (headingDeg > 180) headingDeg -= 360;
      if (headingDeg < -180) headingDeg += 360;
    }

    vTaskDelay(pdMS_TO_TICKS(20));  // 50 Hz sensor read
  }
}

// =============================================================================
// Telemetry HTTP Handler
// =============================================================================

void handleTelemetry() {
  char json[512];
  snprintf(json, sizeof(json),
    "{\"pose\":{\"x\":%.2f,\"y\":%.2f,\"heading\":%.1f},"
    "\"imu\":{\"ax\":%.3f,\"ay\":%.3f,\"az\":%.3f,\"gx\":%.1f,\"gy\":%.1f,\"gz\":%.1f},"
    "\"selfPerception\":{\"locomotion\":%s,\"lastOpcode\":%d},"
    "\"safety\":{\"emergency\":%s,\"uptime\":%lu}}",
    posX, posY, headingDeg,
    accelX, accelY, accelZ, gyroX, gyroY, gyroZ,
    motionVerified ? "true" : "false", lastOpcode,
    emergencyStopped ? "true" : "false", millis()
  );
  telemetryServer.send(200, "application/json", json);
}

// =============================================================================
// Setup (Arduino entry)
// =============================================================================

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n=== RoClaw Unified Firmware v2.0 ===");

  // Status LED
  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, HIGH);

  // WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nConnected! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nWiFi failed — running offline");
  }

  // Camera
  if (initCamera()) {
    Serial.println("Camera: OK (QVGA 320x240)");
  } else {
    Serial.println("Camera: FAILED");
  }

  // MJPEG server
  mjpegServer.on("/stream", HTTP_GET, handleMJPEGStream);
  mjpegServer.begin();
  Serial.printf("MJPEG stream: http://%s/stream\n", WiFi.localIP().toString().c_str());

  // Telemetry server
  telemetryServer.on("/", HTTP_GET, handleTelemetry);
  telemetryServer.on("/telemetry", HTTP_GET, handleTelemetry);
  telemetryServer.begin();
  Serial.printf("Telemetry: http://%s:%d/telemetry\n", WiFi.localIP().toString().c_str(), HTTP_TELEMETRY_PORT);

  // Stepper motors
  stepperL.setMaxSpeed(MAX_SPEED_SPS);
  stepperR.setMaxSpeed(MAX_SPEED_SPS);
  stepperL.setAcceleration(2048);
  stepperR.setAcceleration(2048);

  // Launch FreeRTOS tasks
  xTaskCreatePinnedToCore(motorTask, "MotorTask", 4096, NULL, 2, &motorTaskHandle, 1);
  xTaskCreatePinnedToCore(sensorTask, "SensorTask", 4096, NULL, 1, &sensorTaskHandle, 1);

  lastCommandTime = millis();
  digitalWrite(STATUS_LED, LOW);
  Serial.println("=== Ready ===");
}

// =============================================================================
// Loop (Core 0 — handles HTTP servers)
// =============================================================================

void loop() {
  mjpegServer.handleClient();
  telemetryServer.handleClient();

  // Blink LED based on state
  static unsigned long lastBlink = 0;
  unsigned long now = millis();
  if (emergencyStopped) {
    // Fast blink = emergency
    if (now - lastBlink > 200) {
      digitalWrite(STATUS_LED, !digitalRead(STATUS_LED));
      lastBlink = now;
    }
  } else if (lastOpcode != OP_STOP) {
    // Solid = active
    digitalWrite(STATUS_LED, HIGH);
  } else {
    // Slow blink = idle
    if (now - lastBlink > 1000) {
      digitalWrite(STATUS_LED, !digitalRead(STATUS_LED));
      lastBlink = now;
    }
  }

  delay(1);
}
