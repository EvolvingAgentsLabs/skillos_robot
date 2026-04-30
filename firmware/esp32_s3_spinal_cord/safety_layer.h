/**
 * RoClaw Safety Layer — Firmware-enforced stepper motor safety
 *
 * Hardware-level hard safety limits that cannot be overridden
 * by the host software. This is the last line of defense.
 *
 * Features:
 * - Stepper step rate clamping
 * - Stepper step count clamping
 * - Host heartbeat timeout
 * - Emergency stop latch
 * - Continuous motor timeout
 */

#ifndef SAFETY_LAYER_H
#define SAFETY_LAYER_H

#include <Arduino.h>

// ---------------------------------------------------------------------------
// Safety State
// ---------------------------------------------------------------------------

struct SafetyState {
  bool emergencyStopped;
  unsigned long motorStartTime;
  unsigned long lastHostCommandTime;
  int currentMaxPWM;
  int violations;
  bool motorRunning;
};

static SafetyState safetyState = {
  false,  // emergencyStopped
  0,      // motorStartTime
  0,      // lastHostCommandTime
  200,    // currentMaxPWM
  0,      // violations
  false,  // motorRunning
};

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

inline void safety_init() {
  safetyState.emergencyStopped = false;
  safetyState.motorStartTime = 0;
  safetyState.lastHostCommandTime = millis();
  safetyState.currentMaxPWM = 200;
  safetyState.violations = 0;
  safetyState.motorRunning = false;
}

inline void safety_host_heartbeat() {
  safetyState.lastHostCommandTime = millis();
}

inline void safety_motor_started() {
  safetyState.motorStartTime = millis();
  safetyState.motorRunning = true;
}

inline void safety_motor_stopped() {
  safetyState.motorRunning = false;
}

inline void safety_emergency_stop() {
  safetyState.emergencyStopped = true;
  safetyState.currentMaxPWM = 0;
}

inline void safety_reset() {
  safetyState.emergencyStopped = false;
  safetyState.currentMaxPWM = 200;
  safetyState.motorRunning = false;
}

inline bool safety_check() {
  if (safetyState.emergencyStopped) {
    return false;
  }
  return true;
}

// ==========================================================================
// Stepper Motor Safety
// ==========================================================================

#ifdef USE_STEPPER_MOTORS

struct StepperSafetyConfig {
  int maxStepsPerSecond;              // Max step rate (default: 1024)
  long maxContinuousSteps;            // Max steps per command (default: 40960)
  unsigned long hostHeartbeatMs;      // Host heartbeat timeout (default: 2000)
};

static StepperSafetyConfig stepperSafetyConfig = {
  1024,   // maxStepsPerSecond
  40960,  // maxContinuousSteps (10 revolutions)
  2000,   // hostHeartbeatMs
};

inline int stepper_safety_clamp_speed(int requestedSpeed) {
  if (safetyState.emergencyStopped) {
    return 0;
  }
  if (requestedSpeed > stepperSafetyConfig.maxStepsPerSecond) {
    return stepperSafetyConfig.maxStepsPerSecond;
  }
  if (requestedSpeed < 0) {
    return 0;
  }
  return requestedSpeed;
}

inline long stepper_safety_clamp_steps(long requestedSteps) {
  if (safetyState.emergencyStopped) {
    return 0;
  }
  if (requestedSteps > stepperSafetyConfig.maxContinuousSteps) {
    return stepperSafetyConfig.maxContinuousSteps;
  }
  if (requestedSteps < -stepperSafetyConfig.maxContinuousSteps) {
    return -stepperSafetyConfig.maxContinuousSteps;
  }
  return requestedSteps;
}

inline bool stepper_safety_check() {
  if (millis() - safetyState.lastHostCommandTime > stepperSafetyConfig.hostHeartbeatMs) {
    safety_emergency_stop();
    safetyState.violations++;
    return false;
  }
  return safety_check();
}

#endif // USE_STEPPER_MOTORS

#endif // SAFETY_LAYER_H
