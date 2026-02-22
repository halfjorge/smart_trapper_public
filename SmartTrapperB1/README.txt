Smart Trapper B1

Version: v1.0 (Baseline Stable)

Smart Trapper B1 is a Photoshop + Rust hybrid trapping system designed for plate-based print workflows.

This version represents a known stable baseline before experimental thin-feature protection and debug overlays were introduced.
🔧 System Overview

Smart Trapper consists of three main parts:

    Photoshop Export Script

        Phase2_Export.jsx

        Exports layer masks and generates job.json

    Rust Trapping Engine

        SmartTrapperB1/engine/src/main.rs

        Performs spread-only trap generation

        Outputs traps.json and /traps/*.png

    Photoshop Import Script

        Phase2_Import.jsx

        Imports generated trap masks

        Creates trap layers inside proper color groups

    Controller Script

        Phase2_Run_All.jsx

        Runs Export → Rust → Import automatically

📁 Folder Structure (v1.0 Baseline)

SmartTrapperB1/
│
├── Phase2_Run_All.jsx
├── Phase2_Export.jsx
├── Phase2_Import.jsx
│
├── SmartTrapperB1/
│   ├── engine/
│   │   ├── Cargo.toml
│   │   ├── Cargo.lock
│   │   ├── src/
│   │   │   └── main.rs
│   │   └── target/      (ignored in git)
│   │
│   └── README.txt
│
└── .gitignore

🖨 Workflow
Step 1 — Open PSD

    Top layer = KEY

    Bottom layer = PAPER

    Color plates between them

    Layers must be visible

Step 2 — Run Controller

Run:

Phase2_Run_All.jsx

The script will:

    Detect blend/transparency layers

    Prompt for trap width

    Export masks

    Run Rust engine

    Import traps automatically

⚙ Engine Build

From:

SmartTrapperB1/engine

Run:

cargo build --release

Executable will be generated at:

target/release/smart_trapper_b1.exe

The controller script expects this path unless modified.
🧠 Trapping Logic (v1.0 Baseline)

This version includes:

    Spread-only traps (lower plate spreads under upper plate)

    Paper-island removal

    8-neighborhood boundary detection

    No thin-feature interior protection

    No debug overlay generation

    No composite debug exports

This is the stable pre-experimental implementation.
🚫 What Is NOT Included in v1.0

    Thin feature preservation logic

    Thick interior protection

    Debug overlay PNG exports

    Composite boundary debug masks

    Advanced tolerance overrides

Those were experimental additions made after this baseline.
🔄 Restoring This Version

If future experiments break the system:

git checkout v1.0

Or restore from the tagged commit representing:

    "Stable clean version (no target folder)"

🛡 Recommended Git Ignore

/SmartTrapperB1/engine/target/
/*.log
/traps/
/debug/
/*.psd

💡 Notes

    Rust and Photoshop communicate via job.json, traps.json, and PNG masks.

    PSD document itself is never modified during export.

    Auto-knockout behavior is controlled in Phase2_Export.jsx.

📌 Authoring Notes

This baseline was established after debugging:

    Path execution issues

    .exe location inconsistencies

    Composite blend detection behavior

    Photoshop selection alignment

    Rust mask size mismatches

This commit represents a known working system.