# MX Keypad Sync for World of Warcraft

Syncs a World of Warcraft action bar (default: **Action Bar 3 / Bottom Right**, slots `61–72`) to a **Logitech MX Creative Keypad** (`046d:c354`) in real time, displaying each ability's icon and state (usable, cooldown, out of mana, out of range, active) on the keypad's 9 LCD screens.

- **Page 1 (default):** Slots `1–9` of the action bar on the 3×3 LCD grid.
- **Page 2 (press Right Page button):** Slots `10–12` on the top row. Press Left Page button to return to Page 1.

## Architecture

1. **[wow-addon/MXKeypadSync](wow-addon/MXKeypadSync/)**: A lightweight WoW Lua addon that encodes the 12 slots' `iconFileID` and state flags into a tiny `156×4` pixel strip at the top-left of the screen using a 4-bit-per-channel encoding (immune to Proton/DXVK/compositor color drift).
2. **[companion/](companion/)**: A cross-platform Node.js companion app (works on **Ubuntu Linux** and **Windows**) that captures the pixel strip, fetches & caches the WoW BLP2 icons from `wago.tools`, renders `118×118` icons to the MX Keypad over USB HID, and injects keystrokes when keypad buttons are pressed.

---

## 1. Install the WoW Addon

Copy `wow-addon/MXKeypadSync` into your WoW `Interface/AddOns/` folder:

- **Ubuntu (Steam + Proton):**
  Find your WoW `Interface/AddOns` directory inside the Proton prefix (e.g. `~/.local/share/Steam/steamapps/compatdata/<APPID>/pfx/drive_c/Program Files (x86)/World of Warcraft/_retail_/Interface/AddOns/`) and copy or symlink `MXKeypadSync` there.
- **Windows:**
  Copy `MXKeypadSync` into `C:\Program Files (x86)\World of Warcraft\_retail_\Interface\AddOns\MXKeypadSync`.

In-game slash commands:
- `/mxk` — Show current bar and commands
- `/mxk bar <1-8|topright|bottomright|right|main>` — Switch which action bar is synced (default: `3` / `bottomright`)
- `/mxk size <2-16>` — Adjust pixel cell size (default: `4`)
- `/mxk pos <x> <y>` — Adjust top-left offset
- `/mxk dump` — Print the 12 slot icon IDs and flags in chat

### Bind Keys in WoW

1. Open **Options → Keybindings → AddOns → MX Keypad Sync**.
2. Bind **MX Keypad Slot 1** through **MX Keypad Slot 12** to match `companion/config.json` (defaults to `Ctrl+Shift+1` through `Ctrl+Shift+=`).

---

## 2. Setup the Companion App

### Ubuntu Linux (udev permissions)

Grant your user access to the MX Keypad (`/dev/hidraw*`) and `/dev/uinput` (for virtual keyboard input on Wayland/Proton):

```bash
sudo tee /etc/udev/rules.d/99-mx-keypad-wow.rules <<'EOF'
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="046d", ATTRS{idProduct}=="c354", MODE="0666"
KERNEL=="uinput", GROUP="input", MODE="0660"
EOF
sudo usermod -aG input "$USER"
sudo udevadm control --reload-rules && sudo udevadm trigger
```
*(Log out and back in if you were just added to the `input` group.)*

### Install & Run

```bash
cd companion
npm install
cp config.example.json config.json   # optional: customize keybindings or captureRegion
npm start
```

- On **Ubuntu GNOME Wayland**, a ScreenCast portal dialog will appear once at startup—select your monitor or the WoW window.
- On **X11 / XWayland** (if `x11grab` is preferred), run: `node src/index.js --capture x11`
- On **Windows**, run `npm start` (make sure Logi Options+ is closed or not claiming the keypad).
