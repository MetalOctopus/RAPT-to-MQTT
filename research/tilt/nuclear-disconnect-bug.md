# TiltPi Nuclear Disconnect Bug

## Summary

When one TILT goes out of Bluetooth range, the stock TiltPi flow clears the data for **every** TILT — not just the one that disconnected. This causes all active TILTs to flicker off the dashboard and re-detect from scratch.

## Root Cause

There are 25 `check` function nodes in the TiltPi flow (one per colour pipeline). Each one monitors whether its TILT is still broadcasting by comparing `msg.payload.clock` (current time) against `msg.payload.timeStamp` (last seen). If the gap exceeds `displayTimeout` (default 120,000ms = 2 minutes), the TILT is considered stale.

The bug is in what happens next. Instead of clearing only the stale TILT's data, every check function runs this:

```javascript
if (msg.payload.clock - msg.payload.timeStamp > displayTimeout){
    flow.set('storage-1',undefined);
    flow.set('storage-2',undefined);
    flow.set('storage-3',undefined);
    // ... all the way to storage-25
    flow.set('options',[]);
    if (msg.topic === flow.get('colordropdownSelect')){
        flow.set('colordropdownSelect',undefined);
    }
    msg.show = "hidden";
    return msg;
}
```

All 25 storage slots wiped. The `options` array (list of known colours) emptied. The dropdown selection cleared. Every TILT has to be re-discovered.

## TiltPi Storage Model

Understanding the fix requires understanding how TiltPi stores TILT data:

### The `options` Array
- Sorted list of seen TILT colour names, e.g. `["BLUE", "RED"]`
- Populated by the `Add Parameter` function: when a new colour appears, it's pushed and sorted
- Used as the key for positional storage — `options[0]` maps to `storage-1`, `options[1]` to `storage-2`, etc.

### The `Display` Switch Node (id: `c4b0f249.af093`)
- Routes incoming TILT readings by `msg.payload.Color`
- 25 outputs, each matching `options[N]` (flow variable, read dynamically)
- Output 0 → change node "1" → writes `flow.storage-1`
- Output 1 → change node "2" → writes `flow.storage-2`
- ... and so on

### The Change Nodes (named "1" through "25")
- Simple `move` operations: `msg.payload` → `flow.storage-N`
- One per output of the Display switch

### Reading Storage
- `Get Current SG` / `Get Current Temp`: look up colour in `options`, get index, read `storage-(index+1)`
- `Find macID`: iterates `storage-1` through `storage-25` looking for a matching MAC
- `check` functions: read storage to determine stale status, then (buggy) clear everything

### Data Flow
```
BLE scan → exec node → parse → Add Parameter (updates options array)
                                    ↓
                              Display switch (routes by options[N])
                                    ↓
                              Change node N (writes storage-N)
                                    ↓
                              check function (reads timestamp, decides show/hide)
                                    ↓
                              Dashboard display
```

## The Fix

Replace the nuclear clear in each `check` function with a targeted removal:

```javascript
if (msg.payload.clock - msg.payload.timeStamp > displayTimeout){
    var options = flow.get('options') || [];
    var color = msg.payload.Color;
    var idx = options.indexOf(color);
    if (idx !== -1) {
        // Remove just this colour from the options array
        options.splice(idx, 1);
        flow.set('options', options);

        // Shift storage slots down to fill the gap
        // (storage is positional: storage-N = options[N-1])
        for (var i = idx + 1; i < 25; i++) {
            flow.set('storage-' + i, flow.get('storage-' + (i + 1)));
        }
        flow.set('storage-25', undefined);

        // Clear dropdown only if THIS colour was selected
        if (color === flow.get('colordropdownSelect')) {
            flow.set('colordropdownSelect', undefined);
        }
    }
    msg.show = "hidden";
    return msg;
}
```

### Why This Works
- The `Display` switch reads `options[N]` dynamically on every message. Once we splice the array and shift storage, routing stays aligned automatically.
- BLUE at storage-1 doesn't care that GREEN got removed from storage-2 — BLUE's data stays put, RED shifts from 3→2, and the switch routes RED correctly on the next reading.
- Node-RED is single-threaded, so no race condition if two TILTs go stale at the same time.

### Risk Assessment
- **Low risk.** Worst case: TiltPi dashboard display glitches for multi-TILT setups. The fix only affects the `check` functions, which only control dashboard visibility.
- **RAPT2MQTT unaffected.** Our MQTT nodes tap in upstream of the check functions (after `Add Parameter`), so our data pipeline is completely independent of this fix.
- **Reversible.** If it breaks, removing R2M nodes can also revert the check functions back to stock.

### Implementation Plan
- Patch all 25 `check` function nodes as part of the merge-based TiltPi deploy
- When injecting R2M MQTT nodes, also rewrite the `func` field of each `check` node
- Identify check nodes by: `type == "function"` AND `name == "check"` AND contains `storage-1` in func
- On "Remove RAPT2MQTT Nodes", optionally revert check functions to stock (or leave fixed — the fix is strictly better)

## Node IDs (from backup 2026-04-27)

All 25 check nodes share identical buggy code. They live on tab `a564595f.642818`.

## References
- Backup file: `research/tiltpi_flows_backup_20260427.json`
- Display switch: node `c4b0f249.af093`
- Add Parameter: node `7c18d8fe.188168`
- Storage change nodes: `64f10179.474c9` (1) through `ef0d5029.28851` (25)
