/*
 =====================================================================
  BRACCIO ROBOT ARM - JOYSTICK + BLUETOOTH CONTROL (FAST & SMOOTH)
 =====================================================================

  HOW IT WORKS
  ------------
  - Press the joystick button (or send 'N' from phone) = select the
    NEXT motor. Order: Gripper -> Wrist rotate -> Wrist vertical ->
    Elbow -> Shoulder -> Base -> back to Gripper.
  - Joystick forward / right  = selected motor moves in + direction
  - Joystick backward / left  = selected motor moves in - direction
  - GRIPPER: forward = tighten and HOLD. It only loosens when you
    push backward.
  - Small push = slow and precise. Big push = fast.
  - Phone buttons:  F = forward   B = backward
                    R = right     L = left
                    N = next motor   S = stop

  WIRING
  ------
  JOYSTICK                     ARDUINO
    VCC  ------------------->  5V
    GND  ------------------->  GND
    VRx  ------------------->  A0
    VRy  ------------------->  A1
    SW   ------------------->  D2

  BLUETOOTH (HC-05 or HC-06)   ARDUINO MEGA      ARDUINO UNO
    VCC  ------------------->  5V                5V
    GND  ------------------->  GND               GND
    TXD  ------------------->  pin 19 (RX1)      pin 0 (RX)
    RXD  --[1k]--+--[2k]-GND   pin 18 (TX1)      pin 1 (TX)
                 |
         (Arduino TX goes into the 1k resistor, the module RXD
          connects at the middle point, 2k goes to GND)

  The Braccio shield uses pins 3,5,6,9,10,11,12 - don't use them.

  UNO USERS: unplug the Bluetooth TXD wire while uploading!
  Power the arm from its OWN 5V 4-5A supply, not USB alone.
 =====================================================================
*/

#include <Braccio.h>
#include <Servo.h>

// These exact names are REQUIRED by the Braccio library
Servo base, shoulder, elbow, wrist_rot, wrist_ver, gripper;

// ---- Bluetooth port selection ----
#if defined(__AVR_ATmega2560__)
  #define BT Serial1        // Mega: pins 18/19
#else
  #define BT Serial         // Uno: pins 0/1
#endif

// ---- Joystick pins ----
const int JOY_X  = A0;
const int JOY_Y  = A1;
const int JOY_SW = 2;

// ---- Motors ----
// Order: 0=base 1=shoulder 2=elbow 3=wrist_ver 4=wrist_rot 5=gripper
Servo* servos[6] = {&base, &shoulder, &elbow, &wrist_ver, &wrist_rot, &gripper};
float pos[6]      = {90,  45,  180, 180, 90,  10};   // Braccio start position
const int minA[6] = {0,   15,  0,   0,   0,   10};
const int maxA[6] = {180, 165, 180, 180, 180, 73};
// Gripper: 10 = open, 73 = closed. If yours is reversed, swap 10 and 73
// in the pos[] line above and in minA/maxA.

int selected = 5;           // start with the gripper (top motor)

// ---- Tuning (change these to taste) ----
const unsigned long TICK_MS = 20;      // update every 20 ms
const float MAX_SPEED   = 2.5;         // degrees per tick at full push
const float FINE_SPEED  = 0.15;        // degrees per tick at tiny push
const int   DEADZONE    = 60;          // raise to 80-100 if stick drifts
const float BT_SPEED    = 1.2;         // phone speed
const unsigned long BT_HOLD_MS = 120;  // phone command lasts this long

// ---- State ----
bool lastBtn = HIGH;
unsigned long lastPress = 0, lastTick = 0, btUntil = 0;
int btDir = 0;
int centerX = 512, centerY = 512;

void selectNext() {
  selected--;
  if (selected < 0) selected = 5;      // wrap back to gripper
}

void setup() {
  BT.begin(9600);                      // change to 38400 if your module needs it
  pinMode(JOY_SW, INPUT_PULLUP);

  Braccio.begin();                     // arm moves to start position

  // Calibrate joystick centre. DON'T TOUCH THE STICK at power-up.
  long sx = 0, sy = 0;
  for (int i = 0; i < 20; i++) {
    sx += analogRead(JOY_X);
    sy += analogRead(JOY_Y);
    delay(5);
  }
  centerX = sx / 20;
  centerY = sy / 20;
}

void loop() {
  unsigned long now = millis();

  // ---------- Bluetooth (read as fast as possible) ----------
  while (BT.available()) {
    char c = BT.read();
    if      (c == 'F' || c == 'R') { btDir = +1; btUntil = now + BT_HOLD_MS; }
    else if (c == 'B' || c == 'L') { btDir = -1; btUntil = now + BT_HOLD_MS; }
    else if (c == 'S')             { btDir = 0; }
    else if (c == 'N')             { selectNext(); }
  }
  if (now > btUntil) btDir = 0;

  // ---------- Joystick button (debounced) ----------
  bool btn = digitalRead(JOY_SW);
  if (btn == LOW && lastBtn == HIGH && now - lastPress > 200) {
    selectNext();
    lastPress = now;
  }
  lastBtn = btn;

  // ---------- Move servos at a fixed rate ----------
  if (now - lastTick < TICK_MS) return;
  lastTick = now;

  int x = analogRead(JOY_X) - centerX;
  int y = analogRead(JOY_Y) - centerY;

  int v = (abs(y) >= abs(x)) ? y : x;  // use the axis pushed further
  float speed = 0;

  if (abs(v) > DEADZONE) {
    float t = (float)(abs(v) - DEADZONE) / (512 - DEADZONE);
    t = constrain(t, 0.0, 1.0);
    speed = FINE_SPEED + (MAX_SPEED - FINE_SPEED) * t * t;
    if (v < 0) speed = -speed;
  } else if (btDir != 0) {
    speed = btDir * BT_SPEED;
  }

  if (speed != 0) {
    pos[selected] = constrain(pos[selected] + speed, minA[selected], maxA[selected]);
    servos[selected]->write((int)(pos[selected] + 0.5));
  }
}
