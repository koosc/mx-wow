#!/usr/bin/env python3
"""
Minimal zero-dependency Linux /dev/uinput virtual keyboard for sending keystrokes
on Wayland, XWayland, and Proton/Wine.
Reads one key combo per line from stdin, e.g.:
  F13
  CTRL+SHIFT+1
"""
import ctypes
import fcntl
import os
import struct
import sys
import time

UI_SET_EVBIT = 0x40045564
UI_SET_KEYBIT = 0x40045565
UI_DEV_CREATE = 0x5501
UI_DEV_DESTROY = 0x5502

EV_SYN = 0x00
EV_KEY = 0x01
SYN_REPORT = 0x00

KEYCODES = {
    "1": 2, "2": 3, "3": 4, "4": 5, "5": 6, "6": 7, "7": 8, "8": 9, "9": 10, "0": 11,
    "-": 12, "MINUS": 12, "=": 13, "EQUAL": 13,
    "Q": 16, "W": 17, "E": 18, "R": 19, "T": 20, "Y": 21, "U": 22, "I": 23, "O": 24, "P": 25,
    "A": 30, "S": 31, "D": 32, "F": 33, "G": 34, "H": 35, "J": 36, "K": 37, "L": 38,
    "Z": 44, "X": 45, "C": 46, "V": 47, "B": 48, "N": 49, "M": 50,
    "CTRL": 29, "LCTRL": 29, "SHIFT": 42, "LSHIFT": 42, "ALT": 56, "LALT": 56,
    "F1": 59, "F2": 60, "F3": 61, "F4": 62, "F5": 63, "F6": 64,
    "F7": 65, "F8": 66, "F9": 67, "F10": 68, "F11": 87, "F12": 88,
    "F13": 183, "F14": 184, "F15": 185, "F16": 186, "F17": 187, "F18": 188,
    "F19": 189, "F20": 190, "F21": 191, "F22": 192, "F23": 193, "F24": 194,
    "LEFT": 105, "RIGHT": 106, "UP": 103, "DOWN": 108,
    "[": 26, "]": 27,
}


class UInputUserDev(ctypes.Structure):
    _fields_ = [
        ("name", ctypes.c_char * 80),
        ("id_bustype", ctypes.c_uint16),
        ("id_vendor", ctypes.c_uint16),
        ("id_product", ctypes.c_uint16),
        ("id_version", ctypes.c_uint16),
        ("ff_effects_max", ctypes.c_uint32),
        ("absmax", ctypes.c_int32 * 64),
        ("absmin", ctypes.c_int32 * 64),
        ("absfuzz", ctypes.c_int32 * 64),
        ("absflat", ctypes.c_int32 * 64),
    ]


def emit(fd, ev_type, code, value):
    sec = int(time.time())
    usec = int((time.time() - sec) * 1_000_000)
    os.write(fd, struct.pack("llHHi", sec, usec, ev_type, code, value))


def main():
    fd = os.open("/dev/uinput", os.O_WRONLY | os.O_NONBLOCK)
    fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
    for code in set(KEYCODES.values()):
        fcntl.ioctl(fd, UI_SET_KEYBIT, code)

    dev = UInputUserDev()
    dev.name = b"MXKeypadSync Virtual Keyboard"
    dev.id_bustype = 0x03  # BUS_USB
    dev.id_vendor = 0x1234
    dev.id_product = 0x5678
    dev.id_version = 1
    os.write(fd, bytes(dev))
    fcntl.ioctl(fd, UI_DEV_CREATE)
    time.sleep(0.1)

    try:
        for line in sys.stdin:
            combo = line.strip().upper()
            if not combo:
                continue
            parts = [p.strip() for p in combo.split("+") if p.strip()]
            codes = [KEYCODES[p] for p in parts if p in KEYCODES]
            if not codes:
                continue
            for c in codes:
                emit(fd, EV_KEY, c, 1)
                emit(fd, EV_SYN, SYN_REPORT, 0)
                time.sleep(0.01)
            time.sleep(0.04)
            for c in reversed(codes):
                emit(fd, EV_KEY, c, 0)
                emit(fd, EV_SYN, SYN_REPORT, 0)
                time.sleep(0.005)
    finally:
        fcntl.ioctl(fd, UI_DEV_DESTROY)
        os.close(fd)


if __name__ == "__main__":
    main()
