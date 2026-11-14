local ADDON_NAME = ...

-- Keybinding UI labels
BINDING_HEADER_MXKEYPADSYNC = "MX Keypad Sync"
for i = 1, 12 do
    _G["BINDING_NAME_CLICK MXKeypadSyncBtn" .. i .. ":LeftButton"] = "MX Keypad Slot " .. i
end
BINDING_NAME_MXKEYPADSYNC_PREV_BAR = "Previous Action Bar"
BINDING_NAME_MXKEYPADSYNC_NEXT_BAR = "Next Action Bar"

local BAR_SLOTS = {
    [1] = { name = "Action Bar 1 (Main)",       start = 1 },
    [2] = { name = "Action Bar 2 (BottomLeft)", start = 49 },
    [3] = { name = "Action Bar 3 (BottomRight)",start = 61 },
    [4] = { name = "Action Bar 4 (Right)",      start = 25 },
    [5] = { name = "Action Bar 5 (Right 2)",    start = 37 },
    [6] = { name = "Action Bar 6 (MultiBar5)",  start = 145 },
    [7] = { name = "Action Bar 7 (MultiBar6)",  start = 157 },
    [8] = { name = "Action Bar 8 (MultiBar7)",  start = 169 },
}

local BAR_ALIASES = {
    ["1"] = 1, ["main"] = 1,
    ["2"] = 2, ["bottomleft"] = 2, ["bl"] = 2,
    ["3"] = 3, ["bottomright"] = 3, ["topright"] = 3, ["br"] = 3, ["tr"] = 3,
    ["4"] = 4, ["right"] = 4, ["r1"] = 4,
    ["5"] = 5, ["right2"] = 5, ["left"] = 5, ["r2"] = 5,
    ["6"] = 6, ["bar6"] = 6, ["multibar5"] = 6,
    ["7"] = 7, ["bar7"] = 7, ["multibar6"] = 7,
    ["8"] = 8, ["bar8"] = 8, ["multibar7"] = 8,
}

local DEFAULTS = {
    bar = 3, -- Top-right of bottom cluster (MultiBarBottomRight, slots 61..72)
    cellSize = 4,
    x = 0,
    y = 0,
}

local NUM_SLOTS = 12
local NUM_CELLS = 3 + NUM_SLOTS * 3 -- 3 magic cells + 3 cells per slot = 39 cells

local bridgeFrame
local cells = {}
local secureButtons = {}
local pendingSecureUpdate = false
local dirty = true
local elapsedSinceUpdate = 0
local UPDATE_INTERVAL = 0.08 -- ~12.5 Hz refresh for cooldowns/usability

local function SetCellNibble(cellIndex, nR, nG, nB)
    local tex = cells[cellIndex]
    if not tex then return end
    tex:SetColorTexture((nR * 17) / 255, (nG * 17) / 255, (nB * 17) / 255, 1)
end

local function SetCellRGB(cellIndex, r, g, b)
    local tex = cells[cellIndex]
    if not tex then return end
    tex:SetColorTexture(r / 255, g / 255, b / 255, 1)
end

local function GetSlotCooldownRemaining(slot)
    if GetActionCooldown then
        local start, duration = GetActionCooldown(slot)
        if type(start) == "table" then
            -- Future-proof if API returns a table
            duration = start.duration or 0
            start = start.startTime or 0
        end
        if start and start > 0 and duration and duration > 1.5 then
            local rem = (start + duration) - GetTime()
            if rem > 0 then
                return rem
            end
        end
    end
    return 0
end

local function ReadSlotState(slot)
    local hasAction = HasAction(slot)
    if not hasAction then
        return 0, 0, 0
    end

    local tex = GetActionTexture(slot)
    local iconID = (type(tex) == "number") and tex or 0

    local isUsable, notEnoughMana = IsUsableAction(slot)
    local cdRem = GetSlotCooldownRemaining(slot)
    local onCooldown = cdRem > 0

    local flags = 1 -- bit 0: hasAction
    if isUsable then
        flags = flags + 2 -- bit 1: isUsable
    end
    if notEnoughMana then
        flags = flags + 4 -- bit 2: notEnoughMana
    end
    if onCooldown then
        flags = flags + 8 -- bit 3: onCooldown
    end

    local extra = 0
    if IsCurrentAction(slot) or IsAutoRepeatAction(slot) then
        extra = extra + 1 -- bit 0: active/queued
    end
    if IsActionInRange(slot) == false then
        extra = extra + 2 -- bit 1: out of range
    end

    return iconID, flags, extra
end

local function UpdatePixelBridge()
    local barInfo = BAR_SLOTS[MXKeypadSyncDB.bar] or BAR_SLOTS[3]
    local baseSlot = barInfo.start

    -- Magic header: (255,0,255), (0,255,255), (255,255,0)
    SetCellRGB(1, 255, 0, 255)
    SetCellRGB(2, 0, 255, 255)
    SetCellRGB(3, 255, 255, 0)

    for i = 1, NUM_SLOTS do
        local slot = baseSlot + (i - 1)
        local iconID, flags, extra = ReadSlotState(slot)

        -- Encode 28-bit iconID as 7 nibbles (n6..n0)
        local n0 = bit.band(iconID, 0xF)
        local n1 = bit.band(bit.rshift(iconID, 4), 0xF)
        local n2 = bit.band(bit.rshift(iconID, 8), 0xF)
        local n3 = bit.band(bit.rshift(iconID, 12), 0xF)
        local n4 = bit.band(bit.rshift(iconID, 16), 0xF)
        local n5 = bit.band(bit.rshift(iconID, 20), 0xF)
        local n6 = bit.band(bit.rshift(iconID, 24), 0xF)

        local c = 4 + (i - 1) * 3
        SetCellNibble(c,     n6, n5, n4)
        SetCellNibble(c + 1, n3, n2, n1)
        SetCellNibble(c + 2, n0, flags, extra)
    end
end

local function UpdateSecureButtons()
    if InCombatLockdown() then
        pendingSecureUpdate = true
        return
    end
    pendingSecureUpdate = false
    local barInfo = BAR_SLOTS[MXKeypadSyncDB.bar] or BAR_SLOTS[3]
    local baseSlot = barInfo.start
    for i = 1, NUM_SLOTS do
        local btn = secureButtons[i]
        if btn then
            btn:SetAttribute("type", "action")
            btn:SetAttribute("action", baseSlot + (i - 1))
        end
    end
end

local function GetPhysicalPixelScale()
    if GetPhysicalScreenSize then
        local _, physH = GetPhysicalScreenSize()
        if physH and physH > 0 then
            return 768 / physH
        end
    end
    return 1
end

local function LayoutBridge()
    local px = GetPhysicalPixelScale()
    local size = (MXKeypadSyncDB.cellSize or DEFAULTS.cellSize) * px
    local x = (MXKeypadSyncDB.x or 0) * px
    local y = (MXKeypadSyncDB.y or 0) * px

    bridgeFrame:ClearAllPoints()
    bridgeFrame:SetPoint("TOPLEFT", UIParent, "TOPLEFT", x, -y)
    bridgeFrame:SetSize(NUM_CELLS * size, size)

    for i = 1, NUM_CELLS do
        local tex = cells[i]
        tex:ClearAllPoints()
        tex:SetPoint("TOPLEFT", bridgeFrame, "TOPLEFT", (i - 1) * size, 0)
        tex:SetSize(size, size)
    end
end

local function InitUI()
    bridgeFrame = CreateFrame("Frame", "MXKeypadSyncBridgeFrame", UIParent)
    bridgeFrame:SetFrameStrata("TOOLTIP")
    bridgeFrame:SetFrameLevel(9999)
    bridgeFrame:SetIgnoreParentScale(true)

    -- Solid black backdrop so screen capture doesn't blend with game background
    local bg = bridgeFrame:CreateTexture(nil, "BACKGROUND")
    bg:SetAllPoints(bridgeFrame)
    bg:SetColorTexture(0, 0, 0, 1)

    for i = 1, NUM_CELLS do
        local tex = bridgeFrame:CreateTexture(nil, "ARTWORK")
        cells[i] = tex
    end

    for i = 1, NUM_SLOTS do
        local btn = CreateFrame("Button", "MXKeypadSyncBtn" .. i, UIParent, "SecureActionButtonTemplate")
        btn:RegisterForClicks("AnyUp", "AnyDown")
        secureButtons[i] = btn
    end

    LayoutBridge()
    UpdateSecureButtons()
    UpdatePixelBridge()
end

local function PrintHelp()
    local barInfo = BAR_SLOTS[MXKeypadSyncDB.bar] or BAR_SLOTS[3]
    print("|cff00d4ff[MXKeypadSync]|r Bar: |cffffff00" .. MXKeypadSyncDB.bar .. " (" .. barInfo.name .. ")|r, CellSize: " .. MXKeypadSyncDB.cellSize .. "px, Pos: (" .. MXKeypadSyncDB.x .. ", " .. MXKeypadSyncDB.y .. ")")
    print("  |cffffff00/mxk bar <1-8|topright|bottomright|right|main>|r - Select action bar")
    print("  |cffffff00/mxk size <2-12>|r - Set pixel cell size")
    print("  |cffffff00/mxk pos <x> <y>|r - Set top-left offset")
    print("  |cffffff00/mxk dump|r - Print current 12 slot icon IDs")
    print("  |cffffff00/mxk bind|r - Auto-bind Ctrl+Shift+F1..F12 (slots) & Ctrl+Alt+Left/Right (bars)")
end

function MXKeypadSync_CycleBar(delta)
    if not MXKeypadSyncDB then return end
    local maxBar = (_G["MultiBar5Button1"] ~= nil) and 8 or 5
    local cur = MXKeypadSyncDB.bar or 3
    local nextBar = ((cur - 1 + delta) % maxBar) + 1
    MXKeypadSyncDB.bar = nextBar
    UpdateSecureButtons()
    dirty = true
    local barInfo = BAR_SLOTS[nextBar]
    print("|cff00d4ff[MXKeypadSync]|r Bar " .. nextBar .. ": " .. (barInfo and barInfo.name or ""))
end

SLASH_MXKEYPADSYNC1 = "/mxk"
SLASH_MXKEYPADSYNC2 = "/mxkeypad"
SlashCmdList["MXKEYPADSYNC"] = function(msg)
    local args = {}
    for word in string.gmatch(msg or "", "%S+") do
        table.insert(args, string.lower(word))
    end

    local cmd = args[1]
    if not cmd or cmd == "help" then
        PrintHelp()
        return
    end

    if cmd == "bar" and args[2] then
        local barNum = BAR_ALIASES[args[2]]
        if barNum and BAR_SLOTS[barNum] then
            MXKeypadSyncDB.bar = barNum
            UpdateSecureButtons()
            dirty = true
            print("|cff00d4ff[MXKeypadSync]|r Syncing bar " .. barNum .. ": " .. BAR_SLOTS[barNum].name)
        else
            print("|cff00d4ff[MXKeypadSync]|r Unknown bar '" .. args[2] .. "'. Use 1-8 or topright/bottomright/right/main.")
        end
    elseif cmd == "size" and args[2] then
        local s = tonumber(args[2])
        if s and s >= 2 and s <= 16 then
            MXKeypadSyncDB.cellSize = math.floor(s)
            LayoutBridge()
            print("|cff00d4ff[MXKeypadSync]|r Cell size set to " .. MXKeypadSyncDB.cellSize .. "px.")
        else
            print("|cff00d4ff[MXKeypadSync]|r Size must be between 2 and 16.")
        end
    elseif cmd == "pos" and args[2] and args[3] then
        local x, y = tonumber(args[2]), tonumber(args[3])
        if x and y then
            MXKeypadSyncDB.x = math.floor(x)
            MXKeypadSyncDB.y = math.floor(y)
            LayoutBridge()
            print("|cff00d4ff[MXKeypadSync]|r Position set to (" .. MXKeypadSyncDB.x .. ", " .. MXKeypadSyncDB.y .. ").")
        end
    elseif cmd == "bind" or cmd == "bindbars" then
        if InCombatLockdown() then
            print("|cff00d4ff[MXKeypadSync]|r Cannot change bindings in combat.")
            return
        end
        for i = 1, NUM_SLOTS do
            SetBinding("CTRL-SHIFT-F" .. i, "CLICK MXKeypadSyncBtn" .. i .. ":LeftButton")
        end
        SetBinding("CTRL-ALT-LEFT", "MXKEYPADSYNC_PREV_BAR")
        SetBinding("CTRL-ALT-RIGHT", "MXKEYPADSYNC_NEXT_BAR")
        if SaveBindings and GetCurrentBindingSet then
            SaveBindings(GetCurrentBindingSet())
        end
        print("|cff00d4ff[MXKeypadSync]|r Bound Ctrl+Shift+F1..F12 to slots 1..12 and Ctrl+Alt+Left/Right to cycle bars.")
    elseif cmd == "dump" then
        local barInfo = BAR_SLOTS[MXKeypadSyncDB.bar] or BAR_SLOTS[3]
        print("|cff00d4ff[MXKeypadSync]|r Slots for " .. barInfo.name .. ":")
        for i = 1, NUM_SLOTS do
            local slot = barInfo.start + (i - 1)
            local iconID, flags, extra = ReadSlotState(slot)
            print(string.format("  Slot %2d (action %3d): icon=%d flags=0x%X extra=0x%X", i, slot, iconID, flags, extra))
        end
    else
        PrintHelp()
    end
end

local eventFrame = CreateFrame("Frame")
eventFrame:RegisterEvent("ADDON_LOADED")
eventFrame:RegisterEvent("PLAYER_ENTERING_WORLD")
eventFrame:RegisterEvent("ACTIONBAR_SLOT_CHANGED")
eventFrame:RegisterEvent("ACTIONBAR_UPDATE_STATE")
eventFrame:RegisterEvent("ACTIONBAR_UPDATE_USABLE")
eventFrame:RegisterEvent("ACTIONBAR_UPDATE_COOLDOWN")
eventFrame:RegisterEvent("UPDATE_SHAPESHIFT_FORM")
eventFrame:RegisterEvent("PLAYER_TARGET_CHANGED")
eventFrame:RegisterEvent("PLAYER_REGEN_ENABLED")

eventFrame:SetScript("OnEvent", function(_, event, arg1)
    if event == "ADDON_LOADED" then
        if arg1 == ADDON_NAME then
            MXKeypadSyncDB = MXKeypadSyncDB or {}
            for k, v in pairs(DEFAULTS) do
                if MXKeypadSyncDB[k] == nil then
                    MXKeypadSyncDB[k] = v
                end
            end
            InitUI()
        end
        return
    end

    if event == "PLAYER_REGEN_ENABLED" and pendingSecureUpdate then
        UpdateSecureButtons()
    end

    dirty = true
end)

eventFrame:SetScript("OnUpdate", function(_, elapsed)
    elapsedSinceUpdate = elapsedSinceUpdate + elapsed
    if dirty or elapsedSinceUpdate >= UPDATE_INTERVAL then
        elapsedSinceUpdate = 0
        dirty = false
        if bridgeFrame then
            UpdatePixelBridge()
        end
    end
end)
