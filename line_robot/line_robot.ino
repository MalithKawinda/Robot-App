/*
 * ESP32 Line-Following Robot  <->  Firebase RTDB web app
 * Library: "Firebase Arduino Client Library for ESP8266 and ESP32" (Mobizt) v4.x
 * Works with arduino-esp32 core 2.x and 3.x
 *
 * Firebase paths
 *   /robot/cmd    (written by app): mode, dir, speed, base, kp, kd, act, hb
 *   /robot/status (written by ESP): mode, state, sensors, pos, rssi, hb, junction{type,pattern,n}
 */
#include <Arduino.h>
#include <WiFi.h>
#include <Firebase_ESP_Client.h>
#include "addons/TokenHelper.h"
#include "addons/RTDBHelper.h"

#define WIFI_SSID       "Dialog 4G 568"
#define WIFI_PASSWORD   "9b8D39C1"
#define API_KEY         "AIzaSyAWaMhAj8t3Hcyeeerhk0wHsaCNMLsDrTk"
#define DATABASE_URL    "https://esp32-dab34-default-rtdb.firebaseio.com"

#define LEFT_IN1 27
#define LEFT_IN2 26
#define LEFT_PWM 25
#define RIGHT_IN1 14
#define RIGHT_IN2 13
#define RIGHT_PWM 33
#define PWM_FREQ 1000
#define PWM_RESOLUTION 8
#define LEFT_PWM_CH 0
#define RIGHT_PWM_CH 1

// Alarm buzzer (active buzzer): beeps 0.5 s on / 0.5 s off while the box is open
#define BUZZER_PIN 2     // NOTE: GPIO2 is a boot-strapping pin - the buzzer must not pull it HIGH at power-up

// Front ultrasonic sensor (HC-SR04 type)
#define US_ECHO 34        // input-only pin: fine for echo. HC-SR04 echo is 5 V -> use a 1k/2k divider (or a 3.3 V sensor)
#define US_TRIG 4         // GPIO35 is INPUT-ONLY and cannot drive the trigger -> use an output-capable pin (4, 16, 17, 21...)

// Box-lid servo
#define SERVO_PIN  32
#define SERVO_CH   2      // LEDC channel 2 -> its own timer, so 50 Hz does not disturb the 1 kHz motor PWM
#define SERVO_FREQ 50
#define SERVO_RES  14

// IR sensors, left -> right
const uint8_t IR[5] = {5, 18, 19, 22, 23};

// ---------------- Tuning ----------------
#define LEFT_INVERT    false  // flip if a motor spins backwards
#define RIGHT_INVERT   false
#define LOOP_MS        5      // control loop = 200 Hz
#define ERR_TOL_MS     60     // an invalid sensor pattern shorter than this is ignored (line-gap / noise)
#define JUNCTION_CONFIRM 2    // consecutive identical junction reads (2 x 5 ms) before stopping
#define SLEW           40     // manual mode: max speed change per loop (soft start/stop)
#define MAN_TIMEOUT    800    // manual: stop if no command for this long (ms)
#define AUTO_TIMEOUT   8000   // auto: stop if app silent for this long (ms)
#define LOST_TIMEOUT   1500   // stop if line lost this long (ms)
#define SEARCH_SPEED   110    // pivot speed when searching for line
#define CREEP_SPEED    90     // slow creep used to classify a junction
#define CREEP_MS       90
#define HARD_SLOW      65     // % of base speed while the line is significantly off-centre
#define HARD_GAIN      2.0f   // steering multiplier while significantly off-centre
#define MAX_REV        80     // max reverse speed of inner wheel in sharp corrections

// ---------------- Shared state ----------------
enum State { ST_IDLE, ST_FOLLOW, ST_JUNCTION, ST_TURN, ST_ERROR, ST_MANUAL };
const char* STATE_NAME[] = {"IDLE", "FOLLOW", "JUNCTION", "TURN", "ERROR", "MANUAL"};

// Single source of truth for polarity: true = black reads LOW (0), false = black reads HIGH (1).
// Every part of the code (dots, junctions, turns, calibration) goes through readSensors()/centerOn().
volatile bool  blackLow = true;
// Wiring fixes (set from the app, saved in Firebase):
volatile bool  flipS = false;                       // swap left/right sensors (board mounted/wired mirrored)
volatile bool  linv = LEFT_INVERT, rinv = RIGHT_INVERT;  // reverse a motor's direction
volatile bool  sinv = false;                        // reverse the correction direction (set by the correction check)
volatile int   ckN = 0, ckRes = 0;                  // correction-check result: 1 ok, -1 was steering away (fixed), 0 unclear, 2 not centred
volatile int   steerN = 0, steerRes = 0;            // steering-check result: 1 ok, -1 sensors were mirrored (fixed), 0 unclear, 2 not on line
volatile int   calN = 0, calOk = 0;   // sensor auto-calibration result (reported to the app)      // runtime sensor polarity flip (set from the app)
volatile int   mode = 0;            // 0 auto, 1 manual
volatile char  manDir = 'S';
volatile int   manSpeed = 180, baseSpeed = 150;
// ---- Robot calibration (applies to BOTH modes; stored in Firebase, restored at boot) ----
volatile int lgain = 100, rgain = 100;   // per-motor power trim, %
volatile int lmin = 70, rmin = 70;       // per-motor dead-band (min PWM that makes the wheel turn)
// Turn profiles - every turn sets BOTH motors separately (signed speed, negative = backwards) plus a duration.
// index 0 = 90 deg LEFT, 1 = 90 deg RIGHT, 2 = 180 deg U-turn (always to ONE side: whichever the profile describes).
volatile int pL[3] = {-130, 130, -130};  // left-motor speed
volatile int pR[3] = {130, -130, 130};   // right-motor speed
volatile int pT[3] = {350, 350, 700};    // duration (ms)
volatile int tspd = 130, tsp = 150;      // spin-test / check speed, straight-test speed
volatile int advT[3] = {130, 130, 130};  // forward move BEFORE each turn (ms): 0 = left 90, 1 = right 90, 2 = U-turn. 0 = none
volatile int tex = 250;                  // extra window to catch the line after a turn (ms)
volatile bool tcatch = true;             // finish turns on the line sensor instead of pure timing
// Line-correction pulses: turn strength (PWM difference between wheels) x pulse time, then settle time
volatile int ss = 25, sp = 40;     // slight: strength, pulse ms
volatile int hs = 60, hp = 50;     // hard (significantly off): strength, pulse ms
volatile int st = 40;              // settle (go straight and re-check) ms between pulses
volatile uint32_t lastCmdMs = 0;
volatile char  pendingAct = 0;
volatile int   state = ST_IDLE;
volatile uint8_t shMask = 0;
volatile int   shPos = 0;
volatile int   junctionN = 0;
const char* volatile junctionType = "NONE";
char jPattern[6] = "00000";
char errPattern[6] = "-----";
char jRaw[6] = "00000";

FirebaseData fbStream, fbWrite;
FirebaseAuth auth;
FirebaseConfig config;
bool seeded = false;
String lastAct = "";

// ---------------- Motors ----------------
int curL = 0, curR = 0;

void pwmInit() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(LEFT_PWM, PWM_FREQ, PWM_RESOLUTION);
  ledcAttach(RIGHT_PWM, PWM_FREQ, PWM_RESOLUTION);
  ledcAttach(SERVO_PIN, SERVO_FREQ, SERVO_RES);
#else
  ledcSetup(LEFT_PWM_CH, PWM_FREQ, PWM_RESOLUTION);  ledcAttachPin(LEFT_PWM, LEFT_PWM_CH);
  ledcSetup(RIGHT_PWM_CH, PWM_FREQ, PWM_RESOLUTION); ledcAttachPin(RIGHT_PWM, RIGHT_PWM_CH);
  ledcSetup(SERVO_CH, SERVO_FREQ, SERVO_RES);        ledcAttachPin(SERVO_PIN, SERVO_CH);
#endif
}
void pwmWrite(int pin, int ch, int d) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(pin, d);
#else
  ledcWrite(ch, d);
#endif
}
void setMotor(int in1, int in2, int pin, int ch, int spd, bool inv, int gain, int minp) {
  if (inv) spd = -spd;
  spd = constrain(spd * gain / 100, -255, 255);   // per-motor trim -> straight driving
  int a = abs(spd);
  digitalWrite(in1, spd > 0); digitalWrite(in2, spd < 0);
  pwmWrite(pin, ch, a ? map(a, 1, 255, minp, 255) : 0);
}
void drive(int l, int r) {
  curL = constrain(l, -255, 255); curR = constrain(r, -255, 255);
  setMotor(LEFT_IN1, LEFT_IN2, LEFT_PWM, LEFT_PWM_CH, curL, linv, lgain, lmin);
  setMotor(RIGHT_IN1, RIGHT_IN2, RIGHT_PWM, RIGHT_PWM_CH, curR, rinv, rgain, rmin);
}
void brake() {  // active brake (both inputs HIGH) -> stops far quicker than coasting
  digitalWrite(LEFT_IN1, HIGH); digitalWrite(LEFT_IN2, HIGH); pwmWrite(LEFT_PWM, LEFT_PWM_CH, 255);
  digitalWrite(RIGHT_IN1, HIGH); digitalWrite(RIGHT_IN2, HIGH); pwmWrite(RIGHT_PWM, RIGHT_PWM_CH, 255);
  curL = curR = 0;
}

// ---------------- Box servo ----------------
// Moves smoothly (no jerk for the contents), never moves at boot, and releases the signal after
// settling so it does not buzz or draw current (unless 'shold' is on).
volatile int  sc = 0, so = 90;            // closed / open angle (deg)
volatile int  sspd = 120;                 // sweep speed (deg/s)
volatile int  sauto = 0;                  // auto-close after N seconds (0 = stay open)
volatile int  spmin = 500, spmax = 2400;  // pulse width at 0 / 180 deg (us)
volatile int  shold = 0;                  // 1 = keep holding torque after a move
volatile int  starget = -1;               // -1 = no command yet
volatile bool boxOpen = false;
float spos = -1;
volatile int buzz = 1;                    // 1 = alarm enabled
uint32_t buzzStart = 0, buzzTestUntil = 0;
uint32_t closeAt = 0, releaseAt = 0;

void servoWrite(int duty) {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(SERVO_PIN, duty);
#else
  ledcWrite(SERVO_CH, duty);
#endif
}
int angleToDuty(float a) {
  a = constrain(a, 0.0f, 180.0f);
  float us = spmin + (float)(spmax - spmin) * a / 180.0f;
  return (int)(us / 20000.0f * 16383.0f);       // 20 ms period, 14-bit
}
void boxSet(bool open) {
  boxOpen = open;
  if (open) buzzStart = millis();           // alarm pattern starts with a beep
  starget = open ? so : sc;
  closeAt = (open && sauto > 0) ? millis() + (uint32_t)sauto * 1000UL : 0;
}
void servoTick() {
  uint32_t now = millis();
  if (closeAt && now >= closeAt) { closeAt = 0; boxSet(false); }
  if (starget < 0) return;
  if (spos < 0) spos = sc;                        // assume it starts at the closed position
  float step = max(0.2f, sspd * LOOP_MS / 1000.0f);
  if (fabs(starget - spos) > step) {
    spos += (starget > spos) ? step : -step;
    servoWrite(angleToDuty(spos)); releaseAt = 0;
  } else if (spos != starget) {
    spos = starget; servoWrite(angleToDuty(spos)); releaseAt = now + 500;
  } else if (releaseAt && now >= releaseAt) {
    releaseAt = 0; if (!shold) servoWrite(0);     // stop pulses: no jitter, no idle current
  }
}

void buzzTick() {                          // non-blocking: 0.5 s ON, 0.5 s OFF, repeated
  bool active = (boxOpen && buzz) || (millis() < buzzTestUntil);
  digitalWrite(BUZZER_PIN, active && ((millis() - buzzStart) % 1000) < 500);
}

// ---------------- Front obstacle sensor ----------------
// Non-blocking: the echo pulse is timed by an interrupt, so the 200 Hz control loop is never stalled.
volatile int obsd = 15, obsen = 1;        // hold distance (cm) / enabled
volatile bool blocked = false;            // something is closer than obsd (with hysteresis + 2-read confirmation)
volatile int distCm = 999;
volatile uint32_t echoRise = 0, echoUs = 0;
volatile bool echoDone = false;
uint32_t usLast = 0, usStart = 0; bool usPending = false;

void IRAM_ATTR echoISR() {
  if (digitalRead(US_ECHO)) echoRise = micros();
  else { echoUs = micros() - echoRise; echoDone = true; }
}
void updateBlocked(int cm) {
  static int cnt = 0;
  if (!blocked) { if (cm < obsd) { if (++cnt >= 2) { blocked = true; cnt = 0; } } else cnt = 0; }
  else          { if (cm > obsd + 5) { if (++cnt >= 2) { blocked = false; cnt = 0; } } else cnt = 0; }   // 5 cm hysteresis
}
void usTick() {
  uint32_t now = millis();
  if (echoDone) {
    echoDone = false; usPending = false;
    distCm = (echoUs < 30000) ? (int)(echoUs / 58) : 999;      // 58 us per cm (round trip)
    updateBlocked(distCm);
  }
  if (!usPending && now - usLast >= 60) {                       // one measurement every 60 ms
    usLast = now; usStart = now; usPending = true;
    digitalWrite(US_TRIG, HIGH); delayMicroseconds(10); digitalWrite(US_TRIG, LOW);
  } else if (usPending && now - usStart > 35) {                 // no echo = nothing in range
    usPending = false; distCm = 999; updateBlocked(999);
  }
}
bool obstacleHold() { return obsen && blocked; }
void waitClear() { while (obstacleHold() && pendingAct != 'X') { brake(); usTick(); delay(10); } }

// ---------------- Sensors ----------------
uint8_t readSensors() {
  uint8_t m = 0;
  for (int i = 0; i < 5; i++) if (digitalRead(IR[flipS ? 4 - i : i]) == (blackLow ? LOW : HIGH)) m |= (1 << i);  // bit0 = far left
  return m;
}
int calcPos(uint8_t m, int &cnt) {  // -2000 (line far left) .. +2000 (far right)
  static const int w[5] = {-2000, -1000, 0, 1000, 2000};
  long sum = 0; cnt = 0;
  for (int i = 0; i < 5; i++) if (m >> i & 1) { sum += w[i]; cnt++; }
  return cnt ? sum / cnt : 0;
}
void maskStr(uint8_t m, char *o) { for (int i = 0; i < 5; i++) o[i] = (m >> i & 1) ? '1' : '0'; o[5] = 0; }

// ---------------- Auto logic ----------------
int lastZone = 0;
bool armed = true;
int jHits = 0, lastJt = 0, phase = 0, pDir = 0;   // phase: 0 centred, 1 pulse, 2 settle
uint32_t pStart = 0, errSince = 0;

// Sensor bits: 1 = far-left, 2 = left, 4 = centre, 8 = right, 16 = far-right
#define S_FL 1
#define S_L  2
#define S_C  4
#define S_R  8
#define S_FR 16
// The ONLY valid readings (anything else is a sensor error):
//   centre only                      -> straight
//   centre+left / centre+right       -> slightly off      (line is on that side)
//   left | left+farleft | farleft    -> significantly off (line far on the left)  [mirror for right]
//   centre+left+farleft              -> left turning junction
//   centre+right+farright            -> right turning junction
//   all five                         -> left + right turning junction
int junctionOf(uint8_t m) {
  if (m == (S_C | S_L | S_FL)) return 1;
  if (m == (S_C | S_R | S_FR)) return 2;
  if (m == 31) return 3;
  return 0;
}
// zone: 0 centred, 1 slightly off, 2 significantly off.  dir: -1 line on the left, +1 line on the right
bool classify(uint8_t m, int &zone, int &dir) {
  switch (m) {
    case S_C: zone = 0; dir = 0; return true;
    case S_C | S_L: zone = 1; dir = -1; return true;
    case S_C | S_R: zone = 1; dir = 1; return true;
    case S_L: case S_L | S_FL: case S_FL: zone = 2; dir = -1; return true;
    case S_R: case S_R | S_FR: case S_FR: zone = 2; dir = 1; return true;
  }
  return false;
}

void handleJunction(int jt, uint8_t m) {
  brake();                                   // 1) stop immediately...
  maskStr(m, jPattern);
  for (int i = 0; i < 5; i++) jRaw[i] = digitalRead(IR[flipS ? 4 - i : i]) ? '1' : '0';
  jRaw[5] = 0;
  junctionType = "JUNCTION";                 // type deliberately not used: the app just runs the next command
  junctionN++;                               // 2) ...and flag it at once; the network task publishes within ~20 ms
  armed = false; phase = 0; state = ST_JUNCTION;
}

// Step-and-check centring: turn a little toward the line, go straight for a moment so the sensors
// can show the result, re-check, repeat until only the centre sensor sees the line.
void correct(int zone, int dir) {
  uint32_t now = millis();
  if (zone == 0) { phase = 0; drive(baseSpeed, baseSpeed); return; }
  lastZone = zone;
  bool hard = (zone == 2);
  int b = hard ? baseSpeed * HARD_SLOW / 100 : baseSpeed;
  int dv = hard ? hs : ss; uint32_t pulse = hard ? hp : sp;
  if (phase == 0 || dir != pDir) { phase = 1; pStart = now; pDir = dir; }   // new error or overshoot -> fresh pulse
  if (phase == 1 && now - pStart >= pulse) { phase = 2; pStart = now; }
  else if (phase == 2 && now - pStart >= (uint32_t)st) { phase = 1; pStart = now; }
  // Default: line on the LEFT (dir=-1) -> LEFT wheel faster, RIGHT wheel slower. 'sinv' reverses it.
  int sg = sinv ? dir : -dir;
  if (phase == 1) drive(constrain(b + sg * dv, -MAX_REV, 255), constrain(b - sg * dv, -MAX_REV, 255));
  else drive(b, b);
}

bool centerOn() { return digitalRead(IR[2]) == (blackLow ? LOW : HIGH); }
void timedWait(uint32_t ms) {  // delay that aborts on E-stop
  uint32_t t0 = millis();
  while (millis() - t0 < ms) { if (pendingAct == 'X') break; delay(3); }
}
// Run turn profile idx: left and right motors get their own speeds for the profile's duration. With catchLine,
// stop early once the centre sensor re-finds the line (after >=60% of the time) and allow `tex` ms extra if needed.
void turnRun(int idx, bool catchLine) {
  uint32_t ms = pT[idx], t0 = millis(), limit = ms + (catchLine ? tex : 0);
  bool left = !centerOn();
  drive(pL[idx], pR[idx]);
  while (millis() - t0 < limit) {
    if (pendingAct == 'X') break;
    if (!centerOn()) left = true;
    if (catchLine && left && centerOn() && millis() - t0 >= ms * 6 / 10) break;
    if (!catchLine && millis() - t0 >= ms) break;
    delay(2);
  }
  brake();
}
// Go forward a little before every turn (L / R / U) so the wheel axle sits over the junction centre.
// Duration is set separately per turn type (advT[]); 0 = no forward move for that turn.
void advanceForward(int idx) {              // idx: 0 left, 1 right, 2 U-turn
  waitClear();                              // never drive forward into an obstacle
  int ms = advT[idx];
  if (ms <= 0) return;
  drive(CREEP_SPEED + 20, CREEP_SPEED + 20);
  timedWait(ms);
  brake(); delay(40);                       // let it settle before pivoting
}

void doTurn(char a) {
  armed = false;                 // ignore the junction we are standing on until we have left it
  if (a == 'S') { state = ST_FOLLOW; phase = 0; errSince = 0; return; }
  state = ST_TURN;
  advanceForward(a == 'L' ? 0 : a == 'R' ? 1 : 2);   // before every turn, with its own duration
  if (a == 'L') turnRun(0, tcatch);
  else if (a == 'R') turnRun(1, tcatch);
  else turnRun(2, tcatch);                 // U-turn: always the same side
  brake(); delay(60);
  phase = 0; errSince = 0; state = ST_FOLLOW;
}
// Steering check: with ONLY the centre sensor on the line the robot spins LEFT in tiny steps and watches which
// sensors pick up the line. Spinning left moves the (front-mounted) sensor bar left, so the line must appear on the
// RIGHT side. If it appears on the left, the sensor order is mirrored relative to the robot -> swap it automatically.
void steerCheck() {
  int res = 0;
  brake();
  if (!(readSensors() & S_C)) res = 2;
  else {
    uint32_t t0 = millis();
    drive(-tspd, tspd);
    while (millis() - t0 < 700 && pendingAct != 'X') {
      delay(6);
      uint8_t m = readSensors();
      bool Ls = m & (S_L | S_FL), Rs = m & (S_R | S_FR);
      if (Ls != Rs) { res = Rs ? 1 : -1; break; }
    }
    brake(); delay(80);
    drive(tspd, -tspd);                                   // turn back onto the line
    t0 = millis();
    while (millis() - t0 < 900 && pendingAct != 'X') { delay(4); if (readSensors() == S_C) break; }
    brake();
    if (res == -1) flipS = !flipS;
  }
  steerRes = res; steerN++;
}

// Calibration / manual-mode helper moves (pure timing, no sensors)
void runTest(char a) {
  switch (a) {
    case 'f': drive(tsp, tsp); timedWait(2000); break;       // straight-line test
    case 's': drive(tspd, -tspd); timedWait(1000); break;    // 1 s spin (measure the angle)
    case 'v': advanceForward(0); break;       // forward-only tests
    case 'w': advanceForward(1); break;
    case 'y': advanceForward(2); break;
    case 'l': advanceForward(0); turnRun(0, false); break;
    case 'r': advanceForward(1); turnRun(1, false); break;
    case 'u': advanceForward(2); turnRun(2, false); break;
  }
  brake();
}

// Unrecognised sensor pattern: ignore it and carry on with the last command.
// A running correction pulse finishes its own time, then the robot simply drives straight.
void holdCourse() {
  bool hard = (lastZone == 2);
  int b = hard ? baseSpeed * HARD_SLOW / 100 : baseSpeed;
  int dv = hard ? hs : ss; uint32_t pulse = hard ? hp : sp;
  if (phase == 1 && millis() - pStart >= pulse) { phase = 2; pStart = millis(); }
  int sg = sinv ? pDir : -pDir;
  if (phase == 1) drive(constrain(b + sg * dv, -MAX_REV, 255), constrain(b - sg * dv, -MAX_REV, 255));
  else drive(b, b);
}

// How far from centred a pattern is (0 = centred ... 4 = only an outer sensor, 5 = line lost / unrecognised)
int offScore(uint8_t m) {
  switch (m) {
    case S_C: return 0;
    case S_C | S_L: case S_C | S_R: return 1;
    case S_L: case S_R: return 2;
    case S_L | S_FL: case S_R | S_FR: return 3;
    case S_FL: case S_FR: return 4;
  }
  return 5;
}
// Correction check: the real end-to-end test of "does the correction steer TOWARD the black line?"
// Start centred, knock the robot off the line with a small left spin, then let the normal correction act.
// If the pattern gets worse (line drifts to the outer sensors / lost) the steering direction is reversed.
void correctionCheck() {
  int res = 0;
  brake();
  if (readSensors() != S_C) res = 2;
  else {
    uint32_t t0 = millis(); int z = 0, d = 0;
    drive(-tspd, tspd);
    while (millis() - t0 < 700 && pendingAct != 'X') { delay(5); if (classify(readSensors(), z, d) && z > 0) break; }
    brake(); delay(80);
    if (z > 0) {
      phase = 0; t0 = millis(); int bad = 0;
      while (millis() - t0 < 800 && pendingAct != 'X') {
        delay(5);
        uint8_t m = readSensors();
        if (m == S_C) { res = 1; break; }
        if (classify(m, z, d) && z > 0) correct(z, d); else holdCourse();
        bad = (offScore(m) >= 4) ? bad + 1 : 0;
        if (bad >= 3) { res = -1; break; }      // drifting away from the line
      }
    }
    brake(); phase = 0;
    if (res == -1) sinv = !sinv;
  }
  ckRes = res; ckN++;
}

void autoLoop(uint8_t m, int pos, int cnt, uint32_t age, char act) {
  if (act == 'X') { brake(); state = ST_IDLE; return; }
  switch (state) {
    case ST_IDLE: case ST_ERROR:
      if (act == 'G') { state = ST_FOLLOW; phase = 0; errSince = 0; jHits = 0; armed = (junctionOf(m) == 0); }
      else if (act == 'L' || act == 'R' || act == 'S' || act == 'U') doTurn(act);   // route start from a standstill
      break;
    case ST_JUNCTION:
      if (age > AUTO_TIMEOUT) { state = ST_IDLE; break; }
      if (act == 'L' || act == 'R' || act == 'S' || act == 'U') doTurn(act);
      break;
    case ST_FOLLOW: {
      if (age > AUTO_TIMEOUT) { brake(); state = ST_IDLE; break; }
      if (obstacleHold()) { brake(); phase = 0; break; }       // object ahead: hold until the path clears
      int jt = junctionOf(m);
      if (jt) {
        if (armed) {                                   // confirm, holding course meanwhile
          jHits++;                                      // any junction pattern counts - its type is irrelevant
          if (jHits >= JUNCTION_CONFIRM) { jHits = 0; handleJunction(jt, m); }
        } else { drive(baseSpeed, baseSpeed); }        // still crossing the junction we just left
        errSince = 0;
        break;
      }
      jHits = 0; armed = true;
      int zone, dir;
      if (!classify(m, zone, dir)) { holdCourse(); break; }   // invalid pattern: ignored
      correct(zone, dir);
      break;
    }
    default: break;
  }
}

void manualLoop() {
  if (obstacleHold() && (manDir == 'F' || manDir == 'Q' || manDir == 'E')) { brake(); return; }   // forward is blocked; reverse/turns still allowed
  int s = manSpeed, tl = 0, tr = 0;
  switch (manDir) {
    case 'F': tl = tr = s; break;
    case 'B': tl = tr = -s; break;
    case 'L': tl = -s * 0.7; tr = s * 0.7; break;
    case 'R': tl = s * 0.7; tr = -s * 0.7; break;
    case 'Q': tl = s * 0.4; tr = s; break;    // forward-left arc
    case 'E': tl = s; tr = s * 0.4; break;    // forward-right arc
    default: brake(); return;
  }
  drive(curL + constrain(tl - curL, -SLEW, SLEW), curR + constrain(tr - curR, -SLEW, SLEW));
}

void loop() {
  static uint32_t t = 0;
  static int prevMode = -1;
  if (millis() - t < LOOP_MS) return;
  t = millis();
  servoTick();
  buzzTick();
  usTick();
  uint8_t m = readSensors(); int cnt; int pos = calcPos(m, cnt);
  shMask = m; shPos = pos;
  uint32_t age = millis() - lastCmdMs;
  char act = pendingAct; pendingAct = 0;

  if (mode != prevMode) { brake(); state = mode ? ST_MANUAL : ST_IDLE; prevMode = mode; }
  if (act == 'X') { manDir = 'S'; brake(); if (!mode) state = ST_IDLE; return; }  // E-stop works in any mode
  if (act == 'C' && state != ST_FOLLOW) {     // auto-calibrate polarity: centre sensor on black, others on white
    brake();
    int cv = digitalRead(IR[2]), diff = 0;
    for (int i = 0; i < 5; i++) if (i != 2 && digitalRead(IR[i]) != cv) diff++;
    calOk = (diff >= 3);
    if (calOk) blackLow = (cv == LOW);   // whatever the centre sensor reads on the line IS black
    calN++;
    return;
  }
  if (act == 'B') { buzzStart = millis(); buzzTestUntil = millis() + 3000; return; }   // buzzer test
  if (act == 'O' || act == 'P') { boxSet(act == 'O'); return; }   // open / close the box
  if (act == 'K' && state != ST_FOLLOW && state != ST_TURN) { correctionCheck(); return; }
  if (act == 'T' && state != ST_FOLLOW && state != ST_TURN) { steerCheck(); return; }
  if (act >= 'a' && act <= 'z') { if (state != ST_FOLLOW && state != ST_TURN) runTest(act); return; }
  if (mode == 1) {
    if (manDir != 'S' && age > MAN_TIMEOUT) manDir = 'S';  // dead-man: link lost => stop
    manualLoop();
  } else autoLoop(m, pos, cnt, age, act);
}

// ---------------- Firebase / network ----------------
void applyKV(const String &k, const String &v) {
  if (k == "mode") mode = (v == "manual") ? 1 : 0;
  else if (k == "dir") manDir = seeded && v.length() ? v[0] : 'S';
  else if (k == "speed") manSpeed = constrain(v.toInt(), 0, 255);
  else if (k == "base") baseSpeed = constrain(v.toInt(), 0, 255);
  else if (k == "ss") ss = constrain(v.toInt(), 0, 200);
  else if (k == "sp") sp = constrain(v.toInt(), 5, 500);
  else if (k == "hs") hs = constrain(v.toInt(), 0, 200);
  else if (k == "hp") hp = constrain(v.toInt(), 5, 500);
  else if (k == "st") st = constrain(v.toInt(), 5, 500);
  else if (k == "lg") lgain = constrain(v.toInt(), 30, 110);
  else if (k == "rg") rgain = constrain(v.toInt(), 30, 110);
  else if (k == "lmin") lmin = constrain(v.toInt(), 0, 200);
  else if (k == "rmin") rmin = constrain(v.toInt(), 0, 200);
  else if (k == "l90l") pL[0] = constrain(v.toInt(), -255, 255);
  else if (k == "l90r") pR[0] = constrain(v.toInt(), -255, 255);
  else if (k == "l90t") pT[0] = constrain(v.toInt(), 20, 4000);
  else if (k == "r90l") pL[1] = constrain(v.toInt(), -255, 255);
  else if (k == "r90r") pR[1] = constrain(v.toInt(), -255, 255);
  else if (k == "r90t") pT[1] = constrain(v.toInt(), 20, 4000);
  else if (k == "ul") pL[2] = constrain(v.toInt(), -255, 255);
  else if (k == "ur") pR[2] = constrain(v.toInt(), -255, 255);
  else if (k == "ut") pT[2] = constrain(v.toInt(), 20, 6000);
  else if (k == "tspd") tspd = constrain(v.toInt(), 60, 255);
  else if (k == "tsp") tsp = constrain(v.toInt(), 60, 255);
  else if (k == "advl") advT[0] = constrain(v.toInt(), 0, 1500);
  else if (k == "advr") advT[1] = constrain(v.toInt(), 0, 1500);
  else if (k == "advu") advT[2] = constrain(v.toInt(), 0, 1500);
  else if (k == "obsd") obsd = constrain(v.toInt(), 5, 100);
  else if (k == "obsen") obsen = (v.toInt() != 0);
  else if (k == "buzz") buzz = (v.toInt() != 0);
  else if (k == "tex") tex = constrain(v.toInt(), 0, 1500);
  else if (k == "tcatch") tcatch = (v.toInt() != 0);
  else if (k == "sc") sc = constrain(v.toInt(), 0, 180);
  else if (k == "so") so = constrain(v.toInt(), 0, 180);
  else if (k == "sspd") sspd = constrain(v.toInt(), 10, 720);
  else if (k == "sauto") sauto = constrain(v.toInt(), 0, 600);
  else if (k == "spmin") spmin = constrain(v.toInt(), 300, 1200);
  else if (k == "spmax") spmax = constrain(v.toInt(), 1800, 2700);
  else if (k == "shold") shold = (v.toInt() != 0);
  else if (k == "sang") { if (seeded) { starget = constrain(v.toInt(), 0, 180); closeAt = 0; } }   // live test angle
  else if (k == "sinv") sinv = (v.toInt() != 0);
  else if (k == "flip") flipS = (v.toInt() != 0);
  else if (k == "linv") linv = (v.toInt() != 0);
  else if (k == "rinv") rinv = (v.toInt() != 0);
  else if (k == "bl") blackLow = (v.toInt() != 0);
  else if (k == "act") {
    if (!seeded) lastAct = v;                       // ignore stale command left in DB at boot/reconnect
    else if (v != lastAct) { lastAct = v; if (v.length()) pendingAct = v[0]; }
  }
}
void streamCb(FirebaseStream data) {
  lastCmdMs = millis();
  if (data.dataType() == "json") {
    FirebaseJson *j = data.jsonObjectPtr();
    FirebaseJsonData r;
    const char* keys[] = {"mode", "speed", "base", "ss", "sp", "hs", "hp", "st", "bl", "sc", "so", "sspd", "sauto", "spmin", "spmax", "shold", "sang", "sinv", "flip", "linv", "rinv", "lg", "rg", "lmin", "rmin", "l90l", "l90r", "l90t", "r90l", "r90r", "r90t", "ul", "ur", "ut", "tspd", "tsp", "advl", "advr", "advu", "buzz", "obsd", "obsen", "tex", "tcatch", "dir", "act"};
    for (auto k : keys) if (j->get(r, k) && r.success) applyKV(k, r.to<String>());
    seeded = true;
  } else {
    String k = data.dataPath(); k.remove(0, 1);
    String t = data.dataType(), v;
    if (t == "string") v = data.stringData();
    else if (t == "float" || t == "double") v = String(data.floatData(), 4);
    else v = String(data.intData());
    applyKV(k, v);
  }
}
void streamTimeoutCb(bool t) { if (t) Serial.println("stream timeout, resuming"); }

void publishStatus() {
  FirebaseJson j;
  char s[6]; maskStr(shMask, s);
  j.set("mode", mode ? "manual" : "auto");
  j.set("state", STATE_NAME[state]);
  j.set("sensors", s);
  j.set("pos", (int)shPos);
  j.set("rssi", WiFi.RSSI());
  j.set("hb", (int)millis());
  j.set("junction/type", (const char*)junctionType);
  j.set("junction/pattern", jPattern);
  j.set("junction/n", (int)junctionN);
  j.set("err", errPattern);
  char raw[6]; for (int i = 0; i < 5; i++) raw[i] = digitalRead(IR[flipS ? 4 - i : i]) ? '1' : '0'; raw[5] = 0;
  j.set("bl", (int)blackLow);
  j.set("flip", (int)flipS);
  j.set("sinv", (int)sinv);
  j.set("box", (int)boxOpen);
  j.set("dist", (int)distCm);
  j.set("hold", (int)(obsen && blocked));
  j.set("ck/n", (int)ckN);
  j.set("ck/res", (int)ckRes);
  j.set("steer/n", (int)steerN);
  j.set("steer/res", (int)steerRes);
  j.set("raw", raw);          // what the pins really read (1 = HIGH)
  j.set("junction/raw", jRaw);
  j.set("cal/n", (int)calN);
  j.set("cal/ok", (int)calOk);
  Firebase.RTDB.updateNode(&fbWrite, "/robot/status", &j);
}

void netTask(void *) {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) vTaskDelay(300);
  Serial.println("WiFi OK " + WiFi.localIP().toString());
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  if (Firebase.signUp(&config, &auth, "", "")) Serial.println("Anonymous auth OK");
  else Serial.println(config.signer.signupError.message.c_str());
  config.token_status_callback = tokenStatusCallback;
  Firebase.reconnectWiFi(true);
  Firebase.begin(&config, &auth);
  while (!Firebase.ready()) vTaskDelay(100);
  Firebase.RTDB.setStreamCallback(&fbStream, streamCb, streamTimeoutCb);
  Firebase.RTDB.beginStream(&fbStream, "/robot/cmd");

  int lastN = -1, lastSt = -1, lastCal = -1, lastSteer = -1, lastCk = -1, lastBox = -1, lastHold = -1; uint32_t lastPub = 0;
  for (;;) {
    if (Firebase.ready() && (junctionN != lastN || calN != lastCal || steerN != lastSteer || ckN != lastCk || (int)boxOpen != lastBox || (int)(obsen && blocked) != lastHold || state != lastSt || millis() - lastPub > 400)) {
      lastN = junctionN; lastCal = calN; lastSteer = steerN; lastCk = ckN; lastBox = boxOpen; lastHold = (obsen && blocked); lastSt = state; lastPub = millis();
      publishStatus();
    }
    vTaskDelay(20);
  }
}

void setup() {
  Serial.begin(115200);
  int outs[] = {LEFT_IN1, LEFT_IN2, RIGHT_IN1, RIGHT_IN2};
  for (int p : outs) pinMode(p, OUTPUT);
  for (int i = 0; i < 5; i++) pinMode(IR[i], INPUT);
  pinMode(BUZZER_PIN, OUTPUT); digitalWrite(BUZZER_PIN, LOW);
  pinMode(US_TRIG, OUTPUT); digitalWrite(US_TRIG, LOW);
  pinMode(US_ECHO, INPUT);
  attachInterrupt(digitalPinToInterrupt(US_ECHO), echoISR, CHANGE);
  pwmInit();
  brake();
  lastCmdMs = millis();
  // Control runs in loop() on core 1; all Wi-Fi/Firebase work is isolated on core 0,
  // so slow network calls can never stall the line-following loop.
  xTaskCreatePinnedToCore(netTask, "net", 12288, NULL, 1, NULL, 0);
}
