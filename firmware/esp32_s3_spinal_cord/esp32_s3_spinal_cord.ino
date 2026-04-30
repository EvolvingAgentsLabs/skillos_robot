/**
 * RoClaw Spinal Cord — ESP32-S3 Bytecode-Only Motor Controller
 *
 * Controls 2x 28BYJ-48 stepper motors via ULN2003 drivers over WiFi UDP.
 * Receives 6-byte binary commands (NO JSON). Executes differential drive
 * movements and tracks pose via dead reckoning.
 *
 * Hardware:
 *   - ESP32-S3-DevKitC-1
 *   - 2x 28BYJ-48 (4096 steps/rev, 64:1 gear ratio)
 *   - 2x ULN2003 driver boards
 *   - 6cm diameter wheels, 10cm wheel base
 *
 * Protocol: 6-byte binary frames over UDP port 4210
 * Frame: [0xAA] [OPCODE] [PARAM_L] [PARAM_R] [CHECKSUM] [0xFF]
 */

#include <WiFi.h>
#include <WiFiUdp.h>
#include <AccelStepper.h>

#define USE_STEPPER_MOTORS
#include "safety_layer.h"

// =============================================================================
// WiFi Configuration
// =============================================================================

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const int UDP_PORT = 4210;

// IP filter: set to your host IP for production security.
// Default "0.0.0.0" accepts commands from any source (backward-compatible).
const char* CORTEX_IP = "0.0.0.0";

// =============================================================================
// Pin Definitions — ULN2003 to ESP32-S3
// =============================================================================

// Left motor (ULN2003 #1)
#define LEFT_IN1  4
#define LEFT_IN2  5
#define LEFT_IN3  6
#define LEFT_IN4  7

// Right motor (ULN2003 #2)
#define RIGHT_IN1 15
#define RIGHT_IN2 16
#define RIGHT_IN3 17
#define RIGHT_IN4 18

// Status LED
#define STATUS_LED 2

// =============================================================================
// 28BYJ-48 Motor Constants
// =============================================================================

#define STEPS_PER_REV      4096    // 64:1 gear ratio * 64 steps
#define WHEEL_DIAMETER_CM  6.0f
#define WHEEL_BASE_CM      10.0f
#define MAX_SPEED_STEPS_S  1024    // Safe max for 28BYJ-48
#define DEFAULT_ACCEL      512     // steps/s^2

const float WHEEL_CIRCUMFERENCE_CM = WHEEL_DIAMETER_CM * PI;
const float STEPS_PER_CM = STEPS_PER_REV / WHEEL_CIRCUMFERENCE_CM;

// =============================================================================
// Safety Constants
// =============================================================================

#define HOST_TIMEOUT_MS      2000   // Emergency stop if no command for 2s
#define MAX_CONTINUOUS_STEPS 40960  // Max 10 revolutions per command
#define HEARTBEAT_INTERVAL   500    // Status LED blink interval

// =============================================================================
// Bytecode Protocol — 6-byte frames
// =============================================================================
// Frame: [0xAA] [OPCODE] [PARAM_L] [PARAM_R] [CHECKSUM] [0xFF]
// Checksum = XOR of bytes 1-3 (opcode ^ param_l ^ param_r)

#define FRAME_START     0xAA
#define FRAME_END       0xFF
#define FRAME_SIZE      6

// Opcodes
#define OP_MOVE_FORWARD  0x01
#define OP_MOVE_BACKWARD 0x02
#define OP_TURN_LEFT     0x03
#define OP_TURN_RIGHT    0x04
#define OP_ROTATE_CW     0x05
#define OP_ROTATE_CCW    0x06
#define OP_STOP          0x07
#define OP_GET_STATUS    0x08
#define OP_SET_SPEED     0x09
#define OP_MOVE_STEPS    0x0A
#define OP_MOVE_STEPS_R  0x0B
#define OP_LED_SET       0x10
#define OP_RESET         0xFE

// =============================================================================
// Global Objects
// =============================================================================

// AccelStepper in HALF4WIRE mode for smooth operation
AccelStepper leftMotor(AccelStepper::HALF4WIRE, LEFT_IN1, LEFT_IN3, LEFT_IN2, LEFT_IN4);
AccelStepper rightMotor(AccelStepper::HALF4WIRE, RIGHT_IN1, RIGHT_IN3, RIGHT_IN2, RIGHT_IN4);

WiFiUDP udp;

// =============================================================================
// Pose Tracking (Differential Drive Dead Reckoning)
// =============================================================================

struct RobotPose {
  float x;         // cm
  float y;         // cm
  float heading;   // radians
};

RobotPose pose = {0.0f, 0.0f, 0.0f};
long prevLeftSteps = 0;
long prevRightSteps = 0;

// =============================================================================
// Runtime State
// =============================================================================

unsigned long lastCommandTime = 0;
unsigned long lastHeartbeat = 0;
bool motorsRunning = false;
bool emergencyStopped = false;

// Configurable parameters
int maxSpeedStepsS = MAX_SPEED_STEPS_S;

// UDP buffer
uint8_t udpBuffer[64];
char responseBuffer[256];

// =============================================================================
// Setup
// =============================================================================

void setup() {
  Serial.begin(115200);
  Serial.println("[RoClaw] Spinal Cord — Bytecode Motor Controller V1");

  // Initialize safety layer
  safety_init();

  // Configure status LED
  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, LOW);

  // Configure motors
  leftMotor.setMaxSpeed(MAX_SPEED_STEPS_S);
  leftMotor.setAcceleration(DEFAULT_ACCEL);
  rightMotor.setMaxSpeed(MAX_SPEED_STEPS_S);
  rightMotor.setAcceleration(DEFAULT_ACCEL);

  // Connect to WiFi
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[RoClaw] Connecting to WiFi");

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
    digitalWrite(STATUS_LED, !digitalRead(STATUS_LED));
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("[RoClaw] Connected! IP: ");
    Serial.println(WiFi.localIP());
    digitalWrite(STATUS_LED, HIGH);
  } else {
    Serial.println();
    Serial.println("[RoClaw] WiFi connection failed!");
    digitalWrite(STATUS_LED, LOW);
  }

  // Start UDP listener
  udp.begin(UDP_PORT);
  Serial.printf("[RoClaw] Bytecode UDP listening on port %d\n", UDP_PORT);

  lastCommandTime = millis();
}

// =============================================================================
// Main Loop
// =============================================================================

void loop() {
  // 1. Check for incoming UDP bytecode commands
  int packetSize = udp.parsePacket();
  if (packetSize > 0) {
    // IP filtering: reject packets from unauthorized sources
    if (strcmp(CORTEX_IP, "0.0.0.0") != 0) {
      IPAddress allowed;
      allowed.fromString(CORTEX_IP);
      if (udp.remoteIP() != allowed) {
        Serial.printf("[RoClaw] Rejected packet from %s (expected %s)\n",
                      udp.remoteIP().toString().c_str(), CORTEX_IP);
        udp.flush();
        return;
      }
    }

    int len = udp.read(udpBuffer, sizeof(udpBuffer));
    if (len >= FRAME_SIZE) {
      lastCommandTime = millis();
      safety_host_heartbeat();
      handleBytecodeFrame(udpBuffer);
    }
  }

  // 2. Run stepper motors (non-blocking)
  if (!emergencyStopped) {
    leftMotor.run();
    rightMotor.run();

    // Check if motors have completed their moves
    if (motorsRunning && leftMotor.distanceToGo() == 0 && rightMotor.distanceToGo() == 0) {
      motorsRunning = false;
      safety_motor_stopped();
      disableMotorCoils();
    }
  }

  // 3. Update pose from encoder counts
  updatePose();

  // 4. Safety: host timeout check
  if (millis() - lastCommandTime > HOST_TIMEOUT_MS) {
    if (!emergencyStopped) {
      emergencyStop();
      Serial.println("[RoClaw] Host timeout — emergency stop!");
    }
  }

  // 5. Stepper safety check
  stepper_safety_check();

  // 6. Status LED heartbeat
  if (millis() - lastHeartbeat > HEARTBEAT_INTERVAL) {
    lastHeartbeat = millis();
    if (emergencyStopped) {
      digitalWrite(STATUS_LED, !digitalRead(STATUS_LED));  // Fast blink
    } else if (motorsRunning) {
      digitalWrite(STATUS_LED, HIGH);
    } else {
      digitalWrite(STATUS_LED, (millis() / 1000) % 2 == 0 ? HIGH : LOW);  // Slow blink
    }
  }
}

// =============================================================================
// Bytecode Frame Handler
// =============================================================================

void handleBytecodeFrame(const uint8_t* frame) {
  // Validate frame structure
  if (frame[0] != FRAME_START || frame[5] != FRAME_END) {
    Serial.println("[RoClaw] Invalid frame markers");
    return;
  }

  // Validate checksum (XOR of bytes 1-3)
  uint8_t checksum = frame[1] ^ frame[2] ^ frame[3];
  if (checksum != frame[4]) {
    Serial.printf("[RoClaw] Checksum mismatch: expected 0x%02X, got 0x%02X\n",
                  checksum, frame[4]);
    return;
  }

  uint8_t opcode = frame[1];
  uint8_t paramL = frame[2];
  uint8_t paramR = frame[3];

  // Reset emergency stop on any valid command (except status)
  if (emergencyStopped && opcode != OP_STOP && opcode != OP_GET_STATUS) {
    emergencyStopped = false;
    safety_reset();
  }

  switch (opcode) {
    case OP_MOVE_FORWARD:  opMoveForward(paramL, paramR);  break;
    case OP_MOVE_BACKWARD: opMoveBackward(paramL, paramR); break;
    case OP_TURN_LEFT:     opTurnLeft(paramL, paramR);     break;
    case OP_TURN_RIGHT:    opTurnRight(paramL, paramR);    break;
    case OP_ROTATE_CW:     opRotateCW(paramL, paramR);     break;
    case OP_ROTATE_CCW:    opRotateCCW(paramL, paramR);    break;
    case OP_STOP:          opStop(paramL);                   break;
    case OP_GET_STATUS:    opGetStatus();                   break;
    case OP_SET_SPEED:     opSetSpeed(paramL, paramR);      break;
    case OP_MOVE_STEPS:    opMoveStepsL(paramL, paramR);    break;
    case OP_MOVE_STEPS_R:  opMoveStepsR(paramL, paramR);    break;
    case OP_LED_SET:       opLedSet(paramL, paramR);        break;
    case OP_RESET:         opReset();                       break;
    default:
      Serial.printf("[RoClaw] Unknown opcode: 0x%02X\n", opcode);
      break;
  }
}

// =============================================================================
// Opcode Implementations
// =============================================================================

void opMoveForward(uint8_t speedL, uint8_t speedR) {
  // Map 0-255 to 0-MAX_SPEED_STEPS_S
  int leftSpeed = map(speedL, 0, 255, 0, maxSpeedStepsS);
  int rightSpeed = map(speedR, 0, 255, 0, maxSpeedStepsS);

  leftSpeed = stepper_safety_clamp_speed(leftSpeed);
  rightSpeed = stepper_safety_clamp_speed(rightSpeed);

  // Move a fixed distance (~5cm per command) at the given speed
  long steps = (long)(5.0f * STEPS_PER_CM);
  steps = stepper_safety_clamp_steps(steps);

  leftMotor.setMaxSpeed(leftSpeed);
  rightMotor.setMaxSpeed(rightSpeed);
  leftMotor.move(steps);
  rightMotor.move(steps);
  motorsRunning = true;
  safety_motor_started();
}

void opMoveBackward(uint8_t speedL, uint8_t speedR) {
  int leftSpeed = map(speedL, 0, 255, 0, maxSpeedStepsS);
  int rightSpeed = map(speedR, 0, 255, 0, maxSpeedStepsS);

  leftSpeed = stepper_safety_clamp_speed(leftSpeed);
  rightSpeed = stepper_safety_clamp_speed(rightSpeed);

  long steps = (long)(5.0f * STEPS_PER_CM);
  steps = stepper_safety_clamp_steps(steps);

  leftMotor.setMaxSpeed(leftSpeed);
  rightMotor.setMaxSpeed(rightSpeed);
  leftMotor.move(-steps);
  rightMotor.move(-steps);
  motorsRunning = true;
  safety_motor_started();
}

void opTurnLeft(uint8_t speedL, uint8_t speedR) {
  int leftSpeed = map(speedL, 0, 255, 0, maxSpeedStepsS);
  int rightSpeed = map(speedR, 0, 255, 0, maxSpeedStepsS);

  leftSpeed = stepper_safety_clamp_speed(leftSpeed);
  rightSpeed = stepper_safety_clamp_speed(rightSpeed);

  long steps = (long)(3.0f * STEPS_PER_CM);  // ~3cm arc
  steps = stepper_safety_clamp_steps(steps);

  leftMotor.setMaxSpeed(leftSpeed);
  rightMotor.setMaxSpeed(rightSpeed);
  leftMotor.move(-steps);  // Left wheel backward
  rightMotor.move(steps);   // Right wheel forward
  motorsRunning = true;
  safety_motor_started();
}

void opTurnRight(uint8_t speedL, uint8_t speedR) {
  int leftSpeed = map(speedL, 0, 255, 0, maxSpeedStepsS);
  int rightSpeed = map(speedR, 0, 255, 0, maxSpeedStepsS);

  leftSpeed = stepper_safety_clamp_speed(leftSpeed);
  rightSpeed = stepper_safety_clamp_speed(rightSpeed);

  long steps = (long)(3.0f * STEPS_PER_CM);
  steps = stepper_safety_clamp_steps(steps);

  leftMotor.setMaxSpeed(leftSpeed);
  rightMotor.setMaxSpeed(rightSpeed);
  leftMotor.move(steps);    // Left wheel forward
  rightMotor.move(-steps);  // Right wheel backward
  motorsRunning = true;
  safety_motor_started();
}

void opRotateCW(uint8_t degrees, uint8_t speed) {
  int motorSpeed = map(speed, 0, 255, 0, maxSpeedStepsS);
  motorSpeed = stepper_safety_clamp_speed(motorSpeed);

  float arcCm = ((float)degrees / 360.0f) * PI * WHEEL_BASE_CM;
  long arcSteps = (long)(arcCm * STEPS_PER_CM);
  arcSteps = stepper_safety_clamp_steps(arcSteps);

  leftMotor.setMaxSpeed(motorSpeed);
  rightMotor.setMaxSpeed(motorSpeed);
  leftMotor.move(arcSteps);
  rightMotor.move(-arcSteps);
  motorsRunning = true;
  safety_motor_started();
}

void opRotateCCW(uint8_t degrees, uint8_t speed) {
  int motorSpeed = map(speed, 0, 255, 0, maxSpeedStepsS);
  motorSpeed = stepper_safety_clamp_speed(motorSpeed);

  float arcCm = ((float)degrees / 360.0f) * PI * WHEEL_BASE_CM;
  long arcSteps = (long)(arcCm * STEPS_PER_CM);
  arcSteps = stepper_safety_clamp_steps(arcSteps);

  leftMotor.setMaxSpeed(motorSpeed);
  rightMotor.setMaxSpeed(motorSpeed);
  leftMotor.move(-arcSteps);
  rightMotor.move(arcSteps);
  motorsRunning = true;
  safety_motor_started();
}

// holdMode: 0 = freewheel (disable coils, default), 1 = hold (maintain torque)
// Backward-compatible: existing STOP frames (AA 07 00 00 07 FF) freewheel as before.
void opStop(uint8_t holdMode) {
  leftMotor.stop();
  rightMotor.stop();
  leftMotor.setCurrentPosition(leftMotor.currentPosition());
  rightMotor.setCurrentPosition(rightMotor.currentPosition());
  motorsRunning = false;
  safety_motor_stopped();

  if (holdMode == 0) {
    disableMotorCoils();
  }
  // holdMode == 1: coils stay energized to maintain position

  // Send ACK: echo back STOP frame
  uint8_t ack[] = {FRAME_START, OP_STOP, holdMode, 0x00,
                   (uint8_t)(OP_STOP ^ holdMode), FRAME_END};
  udp.beginPacket(udp.remoteIP(), udp.remotePort());
  udp.write(ack, sizeof(ack));
  udp.endPacket();
}

void opGetStatus() {
  // Respond with JSON status (status is the one exception — human-readable)
  snprintf(responseBuffer, sizeof(responseBuffer),
    "{\"pose\":{\"x\":%.2f,\"y\":%.2f,\"h\":%.4f},"
    "\"steps\":{\"l\":%ld,\"r\":%ld},"
    "\"run\":%s,\"estop\":%s,\"rssi\":%d}",
    pose.x, pose.y, pose.heading,
    leftMotor.currentPosition(), rightMotor.currentPosition(),
    motorsRunning ? "true" : "false",
    emergencyStopped ? "true" : "false",
    WiFi.RSSI());
  udp.beginPacket(udp.remoteIP(), udp.remotePort());
  udp.write((const uint8_t*)responseBuffer, strlen(responseBuffer));
  udp.endPacket();
}

void opSetSpeed(uint8_t maxSpeed, uint8_t acceleration) {
  maxSpeedStepsS = map(maxSpeed, 0, 255, 1, 1024);
  int accel = map(acceleration, 0, 255, 1, 2048);

  leftMotor.setMaxSpeed(maxSpeedStepsS);
  rightMotor.setMaxSpeed(maxSpeedStepsS);
  leftMotor.setAcceleration(accel);
  rightMotor.setAcceleration(accel);
}

void opMoveStepsL(uint8_t hi, uint8_t lo) {
  // 16-bit signed step count for left motor
  int16_t steps = (int16_t)((hi << 8) | lo);
  long clampedSteps = stepper_safety_clamp_steps((long)steps);
  leftMotor.move(clampedSteps);
  motorsRunning = true;
  safety_motor_started();
}

void opMoveStepsR(uint8_t hi, uint8_t lo) {
  // 16-bit signed step count for right motor
  int16_t steps = (int16_t)((hi << 8) | lo);
  long clampedSteps = stepper_safety_clamp_steps((long)steps);
  rightMotor.move(clampedSteps);
  motorsRunning = true;
  safety_motor_started();
}

void opLedSet(uint8_t r, uint8_t g) {
  // Simple LED indicator (use status LED for now)
  digitalWrite(STATUS_LED, r > 0 ? HIGH : LOW);
}

void opReset() {
  // Reset pose and motor positions
  pose = {0.0f, 0.0f, 0.0f};
  prevLeftSteps = 0;
  prevRightSteps = 0;
  leftMotor.setCurrentPosition(0);
  rightMotor.setCurrentPosition(0);
  motorsRunning = false;
  emergencyStopped = false;
  safety_reset();
  disableMotorCoils();
}

// =============================================================================
// Pose Tracking (Differential Drive Odometry)
// =============================================================================

void updatePose() {
  long currentLeft = leftMotor.currentPosition();
  long currentRight = rightMotor.currentPosition();

  long deltaLeft = currentLeft - prevLeftSteps;
  long deltaRight = currentRight - prevRightSteps;

  if (deltaLeft == 0 && deltaRight == 0) return;

  float leftDistCm = deltaLeft / STEPS_PER_CM;
  float rightDistCm = deltaRight / STEPS_PER_CM;

  float linearCm = (leftDistCm + rightDistCm) / 2.0f;
  float angularRad = (rightDistCm - leftDistCm) / WHEEL_BASE_CM;

  pose.heading += angularRad;
  // Normalize heading to [-PI, PI]
  while (pose.heading > PI) pose.heading -= 2.0f * PI;
  while (pose.heading < -PI) pose.heading += 2.0f * PI;

  pose.x += linearCm * cos(pose.heading);
  pose.y += linearCm * sin(pose.heading);

  prevLeftSteps = currentLeft;
  prevRightSteps = currentRight;
}

// =============================================================================
// Helpers
// =============================================================================

void emergencyStop() {
  leftMotor.stop();
  rightMotor.stop();
  leftMotor.setCurrentPosition(leftMotor.currentPosition());
  rightMotor.setCurrentPosition(rightMotor.currentPosition());
  motorsRunning = false;
  emergencyStopped = true;
  safety_emergency_stop();
  disableMotorCoils();
}

void disableMotorCoils() {
  // Turn off all coils to save power (28BYJ-48 draws ~240mA when energized)
  digitalWrite(LEFT_IN1, LOW);
  digitalWrite(LEFT_IN2, LOW);
  digitalWrite(LEFT_IN3, LOW);
  digitalWrite(LEFT_IN4, LOW);
  digitalWrite(RIGHT_IN1, LOW);
  digitalWrite(RIGHT_IN2, LOW);
  digitalWrite(RIGHT_IN3, LOW);
  digitalWrite(RIGHT_IN4, LOW);
}
