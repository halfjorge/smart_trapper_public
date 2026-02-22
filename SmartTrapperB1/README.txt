SmartTrapper B1 (Hybrid export → external compute → reimport)

WHAT THIS DOES
1) Photoshop exports each separation as a mask PNG (white/transparent) + strict job.json metadata.
2) Rust engine computes traps:
   Trap(A over B) = (dilate(A, trapPx) ∩ B) − A
   If SOURCE A is MULTIPLY and KEY exists, trap also intersects KEY.
3) Photoshop imports computed trap masks back into the PSD as TRAP__A_over_B layers,
   inside the SOURCE group (COLOR__<A>), matching SOURCE blend/opacity/fillOpacity.

ASSUMPTIONS (same as your in-PSD script)
- Top layer is KEY (untouched)
- Bottom layer is PAPER (untouched)
- Color layers are visible ArtLayers between them

FOLDER STRUCTURE
ps/
  export_printed_shapes.jsx
  import_traps.jsx
engine/
  Cargo.toml
  src/main.rs

RUN STEPS
A) Photoshop export
   File > Scripts > Browse... -> ps/export_printed_shapes.jsx
   Choose an output folder, e.g. C:\temp\byrne_job
   It will create:
     masks/*.png
     job.json

B) Build + run Rust engine
   Open Command Prompt / PowerShell:

   cd SmartTrapperB1\engine
   cargo build --release

   Then run:
   target\release\smart_trapper_b1.exe "C:\temp\byrne_job" 5

   It will create:
     traps/*.png
     traps.json

C) Photoshop import
   File > Scripts > Browse... -> ps/import_traps.jsx
   Select the same job folder (contains job.json + traps.json)

NOTES
- Trap PNGs are white where trap exists, transparent elsewhere.
- Importer fills trap selections with SOURCE ink color and matches SOURCE appearance.
